/**
 * The stateless remoteStorage front door.
 *
 * It answers CORS preflights at the edge, authenticates the OAuth bearer token
 * (`auth.ts`), and enforces the per-module read/write **scope** model
 * (`scope.ts`) — including the public-`/public/`-document exception — before
 * forwarding an already-authorized request to the per-account Durable Object,
 * which owns all storage consistency. One Durable Object per account (keyed by
 * the parsed account id); the handler is mountable under any path prefix because
 * it routes purely on the request URL via {@link RemoteStorageConfig.parsePath}.
 */

import { hostFromUrl, type LogFields } from "@dwk/log";

import { authenticate, type AuthResult } from "./auth.js";
import {
  INTERNAL_HEADERS,
  resolveConfig,
  type RemoteStorageConfig,
  type RemoteStorageEnv,
  type ResolvedConfig,
} from "./config.js";
import { ALLOWED_METHODS, preflightResponse, withCors } from "./cors.js";
import { RemoteStorageLogEvent } from "./log.js";
import { authorizeScopes, isPublicDocument } from "./scope.js";

/** A `fetch`-compatible Worker handler. */
export type RemoteStorageHandler = (
  request: Request,
  env: RemoteStorageEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/** Client headers safe to forward verbatim to the Durable Object. */
const FORWARDED_HEADERS = [
  "content-type",
  "content-length",
  "if-match",
  "if-none-match",
] as const;

/** Methods the storage API serves; anything else is `405`. */
const METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

/** Fail loudly if a required Cloudflare binding is missing (no silent degradation). */
function assertBindings(env: RemoteStorageEnv): void {
  if (!env.STORAGE) {
    throw new Error(
      "@dwk/remotestorage: missing required Durable Object binding `STORAGE`",
    );
  }
  if (!env.BLOBS) {
    throw new Error("@dwk/remotestorage: missing required R2 binding `BLOBS`");
  }
}

/** Build the internal DO request: clean account-relative URL + config header. */
function internalRequest(
  request: Request,
  storagePath: string,
  config: ResolvedConfig,
): Request {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set(
    INTERNAL_HEADERS.config,
    JSON.stringify(
      config.maxInlineBytes !== undefined
        ? { maxInlineBytes: config.maxInlineBytes }
        : {},
    ),
  );

  const url = new URL(request.url);
  url.pathname = storagePath;
  url.search = "";

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url.toString(), {
    method: request.method,
    headers,
    ...(hasBody ? { body: request.body } : {}),
  });
}

/** Emit a structured event on both the logger and the metrics seam. */
function emit(
  config: ResolvedConfig,
  level: "info" | "warn",
  event: string,
  fields?: LogFields,
): void {
  config.logger[level](event, fields);
  config.metrics.count(event, fields);
}

/** A `401` with the Bearer challenge and a machine-readable failure reason. */
function unauthorized(reason: string): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "www-authenticate": `Bearer realm="remotestorage", error="invalid_token", error_description="${reason}"`,
    },
  });
}

/** A `403` for an authenticated request whose scopes do not cover the target. */
function forbidden(): Response {
  return new Response("Forbidden", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Decide whether a request is authorized, given the auth result, the storage
 * path, and whether the method writes. Returns `null` to allow, or the Response
 * to return. The `/public/` document read is allowed even unauthenticated; every
 * other access needs a scope covering the path's module (or `*`).
 */
function authorize(
  config: ResolvedConfig,
  result: AuthResult,
  path: string,
  needWrite: boolean,
  method: string,
): Response | null {
  const publicRead = !needWrite && isPublicDocument(path);

  if (result.kind === "anonymous") {
    if (publicRead) return null;
    emit(config, "warn", RemoteStorageLogEvent.AccessDenied, {
      method,
      status: 401,
    });
    return unauthorized("missing_token");
  }

  // Authenticated: a public-document read always succeeds; otherwise the token
  // must carry a scope for the path's module at the required mode. (A `rejected`
  // result never reaches here — the caller returns before authorizing.)
  if (result.kind === "rejected") return unauthorized(result.reason);
  if (publicRead || authorizeScopes(result.auth.scopes, path, needWrite)) {
    return null;
  }
  emit(config, "warn", RemoteStorageLogEvent.AccessDenied, {
    method,
    status: 403,
  });
  return forbidden();
}

/**
 * Create the stateless remoteStorage front-door handler. CORS and auth are
 * enforced here; storage flows through the per-account
 * {@link RemoteStorageObject} so it remains the single consistency authority.
 */
export function createRemoteStorage(
  config: RemoteStorageConfig,
): RemoteStorageHandler {
  const resolved = resolveConfig(config);

  return async (request, env, _ctx) => {
    assertBindings(env);
    const requestOrigin = request.headers.get("origin");
    const method = request.method.toUpperCase();

    // Preflight is answered at the edge — no auth, no store hit.
    if (method === "OPTIONS") return preflightResponse(requestOrigin);

    const respond = (response: Response): Response =>
      withCors(response, requestOrigin);

    if (!METHODS.has(method)) {
      return respond(
        new Response("Method Not Allowed", {
          status: 405,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            allow: ALLOWED_METHODS,
          },
        }),
      );
    }

    const parsed = resolved.parsePath(new URL(request.url).pathname);
    if (!parsed) {
      return respond(
        new Response("Not Found", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      );
    }

    const result = await authenticate(request, resolved);
    if (result.kind === "rejected") {
      emit(resolved, "warn", RemoteStorageLogEvent.AuthRejected, {
        reason: result.reason,
      });
      return respond(unauthorized(result.reason));
    }
    if (result.kind === "authenticated") {
      emit(resolved, "info", RemoteStorageLogEvent.AuthAccepted, {
        ...(result.auth.subject
          ? { subjectHost: hostFromUrl(result.auth.subject) }
          : {}),
      });
    }

    const needWrite = method === "PUT" || method === "DELETE";
    const denied = authorize(resolved, result, parsed.path, needWrite, method);
    if (denied) return respond(denied);

    const forwarded = internalRequest(request, parsed.path, resolved);
    const id = env.STORAGE.idFromName(parsed.account);
    const response = await env.STORAGE.get(id).fetch(forwarded);
    return respond(response);
  };
}
