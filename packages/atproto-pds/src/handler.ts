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
} from "./config";

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

/** Reach the per-account repository DO (one per account DID; no sharding). */
function repoStub(config: ResolvedConfig, env: AtprotoPdsEnv) {
  const id = env.REPO.idFromName(config.did);
  return env.REPO.get(id);
}

/** Forward a request to the DO, attaching the internal config header. */
function forwardToDo(
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
  return repoStub(config, env).fetch(forwarded);
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

    // The handle → DID binding, served from the account's own domain. This is
    // what lets any app resolve `at://<handle>` without a central directory.
    if (path === "/.well-known/atproto-did") {
      if (method !== "GET" && method !== "HEAD") {
        return text(405, "Method Not Allowed");
      }
      return new Response(method === "HEAD" ? null : resolved.did, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // The DID document carries the repository signing key and the PDS service
    // endpoint; the DO builds it because only the DO holds the key.
    if (path === "/.well-known/did.json") {
      if (method !== "GET" && method !== "HEAD") {
        return text(405, "Method Not Allowed");
      }
      return forwardToDo(resolved, env, request);
    }

    if (path.startsWith("/xrpc/")) {
      return forwardToDo(resolved, env, request);
    }

    return text(404, "Not Found");
  };
}
