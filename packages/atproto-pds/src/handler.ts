/**
 * The stateless AT Protocol PDS front door.
 *
 * It serves the two identity documents that root the account at its own domain —
 * `/.well-known/atproto-did` (the handle → DID binding) and `/.well-known/did.json`
 * (the DID document) — and routes the entire XRPC surface (`/xrpc/<nsid>`) to the
 * per-account {@link AtprotoRepoObject}, which owns the signing key, the MST, and
 * the commit chain. The handler routes purely on the request URL, so it is
 * mountable under any path prefix (include the prefix in `baseUrl`).
 */

import {
  INTERNAL_CONFIG_HEADER,
  forwardedConfig,
  resolveConfig,
  type AtprotoPdsConfig,
  type AtprotoPdsEnv,
  type ResolvedConfig,
} from "./config.js";

/** A `fetch`-compatible Worker handler. */
export type AtprotoPdsHandler = (
  request: Request,
  env: AtprotoPdsEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/** Fail loudly if a required Cloudflare binding is missing. */
function assertBindings(env: AtprotoPdsEnv): void {
  if (!env.REPO) {
    throw new Error(
      "@dwk/atproto-pds: missing required Durable Object binding `REPO`",
    );
  }
  if (!env.BLOBS) {
    throw new Error("@dwk/atproto-pds: missing required R2 binding `BLOBS`");
  }
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Reach the per-account repository DO (one per account; no sharding). */
function repoStub(config: ResolvedConfig, env: AtprotoPdsEnv) {
  // Route by a stable, method-independent key (the host): a fresh did:plc
  // account's DID is not known until the DO signs its genesis operation, so the
  // DID cannot be the routing name.
  const id = env.REPO.idFromName(config.accountKey);
  return env.REPO.get(id);
}

/**
 * Whether a response body is genuinely an unhandled-error signal from the DO
 * — `errorResponse`'s generic `InternalServerError` envelope, or a non-JSON
 * body (the DO's pre-config-parse "missing internal config" bypass) — as
 * opposed to a legitimate XRPC error that happens to carry a 500 status (none
 * exist in this package today, but this keeps the signal precise if one ever
 * does). Takes a `response.clone()` so reading the body here never consumes
 * it for the real caller.
 */
async function isUnhandledErrorBody(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return body.error === "InternalServerError";
  } catch {
    return true;
  }
}

/** Forward a request to the DO, attaching the internal config header. */
async function forwardToDo(
  config: ResolvedConfig,
  env: AtprotoPdsEnv,
  request: Request,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set(INTERNAL_CONFIG_HEADER, JSON.stringify(forwardedConfig(config)));
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? null
        : request.body,
    ...(request.body ? { duplex: "half" } : {}),
  } as RequestInit);
  const response = await repoStub(config, env).fetch(forwarded);
  // The DO cannot hold the injected logger/metrics across the fetch()
  // boundary (see xrpc.ts's errorResponse) — this is where the real seams are
  // still in scope, so an aggregate signal is recorded here instead. The
  // response body only ever carries the generic "Internal server error"
  // message (see errorResponse), so there is no real detail to forward — the
  // path is the only useful dimension available at this layer.
  if (
    response.status === 500 &&
    (await isUnhandledErrorBody(response.clone()))
  ) {
    config.logger.error("atproto_pds.xrpc.internal_error", {
      path: new URL(request.url).pathname,
    });
    config.metrics.count("atproto_pds.xrpc.internal_error");
  }
  return response;
}

/**
 * Create the stateless PDS front-door handler. Identity documents are served
 * here; all authoritative state lives in the {@link AtprotoRepoObject} the XRPC
 * request is routed to.
 */
export function createAtprotoPds(config: AtprotoPdsConfig): AtprotoPdsHandler {
  const resolved = resolveConfig(config);

  return async (request, env, _ctx) => {
    assertBindings(env);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // The handle → DID binding. For did:web the DID is known here; for did:plc
    // the DO is the source of truth (it derived the DID at genesis), so forward.
    if (path === "/.well-known/atproto-did") {
      if (method !== "GET" && method !== "HEAD") {
        return text(405, "Method Not Allowed");
      }
      if (resolved.didMethod === "plc") {
        return forwardToDo(resolved, env, request);
      }
      return new Response(method === "HEAD" ? null : resolved.did, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // The DID document is served from the origin only for did:web; a did:plc
    // account's document lives in the PLC directory, not here.
    if (path === "/.well-known/did.json") {
      if (method !== "GET" && method !== "HEAD") {
        return text(405, "Method Not Allowed");
      }
      if (resolved.didMethod === "plc") {
        return text(404, "Not Found");
      }
      return forwardToDo(resolved, env, request);
    }

    if (path.startsWith("/xrpc/")) {
      return forwardToDo(resolved, env, request);
    }

    return text(404, "Not Found");
  };
}
