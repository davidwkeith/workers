/**
 * `@dwk/solid-pod` — edge-native Solid Pod.
 *
 * A stateless Worker front door over a per-pod Durable Object that is the
 * consistency, authz, and notification authority, with R2 for blob bodies. This
 * is the only `@dwk` package that ships a Durable Object. See
 * `spec/packages/solid-pod.md`.
 */

/** Cloudflare bindings required by the Solid Pod handler and Durable Object. */
export interface SolidPodEnv {
  /** Durable Object namespace for the per-pod class ({@link SolidPodObject}). */
  readonly POD: DurableObjectNamespace;
  /** R2 bucket holding blob bodies. */
  readonly BLOBS: R2Bucket;
}

/** Configuration passed to {@link createSolidPod}. */
export interface SolidPodConfig {
  /** The WebID identity root / base URL (e.g. `https://example.com`). */
  readonly baseUrl: string;
}

/** A `fetch`-compatible Worker handler. */
export type SolidPodHandler = (
  request: Request,
  env: SolidPodEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/**
 * Create the stateless Solid Pod front-door handler, mountable under a path
 * prefix. Writes funnel through the per-pod {@link SolidPodObject}.
 */
export function createSolidPod(_config: SolidPodConfig): SolidPodHandler {
  return async (_request, _env, _ctx) =>
    new Response("Not Implemented", { status: 501 });
}

/**
 * The per-pod Durable Object: the single-threaded consistency, authz, and
 * notification authority for one Solid Pod. Consumers bind this class as a
 * Durable Object namespace in their `wrangler.toml`.
 */
export class SolidPodObject {
  constructor(_state: DurableObjectState, _env: SolidPodEnv) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response("Not Implemented", { status: 501 });
  }
}
