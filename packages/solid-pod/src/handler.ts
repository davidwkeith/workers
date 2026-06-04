/**
 * The stateless Solid Pod front door.
 *
 * It authenticates DPoP-bound bearer tokens at the edge (`auth.ts`), then hands
 * the request — augmented with the verified agent facts via internal headers —
 * to the per-pod Durable Object, which owns all consistency, authorization, and
 * notification logic. v1 runs a single Durable Object per `baseUrl` (no
 * sharding). The handler is mountable under any path prefix because it routes
 * purely on the request URL.
 */

import {
  INTERNAL_HEADERS,
  resolveConfig,
  type ResolvedConfig,
  type SolidPodConfig,
  type SolidPodEnv,
} from "./config";
import { authenticate } from "./auth";

/** A `fetch`-compatible Worker handler. */
export type SolidPodHandler = (
  request: Request,
  env: SolidPodEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/** Client headers that are safe to forward verbatim to the Durable Object. */
const FORWARDED_HEADERS = [
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
  "slug",
  "link",
  "origin",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
] as const;

/** Fail loudly if a required Cloudflare binding is missing (no silent degradation). */
function assertBindings(env: SolidPodEnv): void {
  if (!env.POD) {
    throw new Error(
      "@dwk/solid-pod: missing required Durable Object binding `POD`",
    );
  }
  if (!env.BLOBS) {
    throw new Error("@dwk/solid-pod: missing required R2 binding `BLOBS`");
  }
}

/** Build the internal DO request, stripping any client-supplied auth headers. */
function internalRequest(
  request: Request,
  config: ResolvedConfig,
  auth: { webid: string; jti: string; jkt: string } | null,
): Request {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // The DO trusts these headers, so they are always set by us — never passed
  // through from the client.
  if (auth) {
    headers.set(INTERNAL_HEADERS.webid, auth.webid);
    headers.set(INTERNAL_HEADERS.jti, auth.jti);
    headers.set(INTERNAL_HEADERS.jkt, auth.jkt);
  }
  headers.set(
    INTERNAL_HEADERS.config,
    JSON.stringify({
      owners: config.owners,
      allowAnonymousWrites: config.allowAnonymousWrites,
      ...(config.maxInlineBytes !== undefined
        ? { maxInlineBytes: config.maxInlineBytes }
        : {}),
    }),
  );

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(request.url, {
    method: request.method,
    headers,
    ...(hasBody ? { body: request.body } : {}),
  });
}

/** A `401` with the DPoP challenge and a machine-readable failure reason. */
function unauthorized(reason: string): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "www-authenticate": `DPoP realm="solid", error="invalid_token", error_description="${reason}"`,
    },
  });
}

/**
 * Create the stateless Solid Pod front-door handler. Writes funnel through the
 * per-pod {@link SolidPodObject}; reads and notifications likewise route through
 * it so the DO remains the single consistency authority.
 */
export function createSolidPod(config: SolidPodConfig): SolidPodHandler {
  const resolved = resolveConfig(config);

  return async (request, env, _ctx) => {
    assertBindings(env);

    const result = await authenticate(request, resolved);
    if (result.kind === "rejected") return unauthorized(result.reason);

    const auth = result.kind === "authenticated" ? result.context : null;
    const forwarded = internalRequest(request, resolved, auth);

    // One Durable Object per pod, keyed by the identity root (no sharding).
    const id = env.POD.idFromName(resolved.baseUrl);
    return env.POD.get(id).fetch(forwarded);
  };
}
