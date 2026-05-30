/**
 * `@dwk/micropub` — Micropub create/update/delete endpoint with an R2-backed
 * media endpoint.
 *
 * Endpoint package: exports a factory returning a `fetch`-compatible handler,
 * mountable under a path prefix. Authorizes via DPoP-bound IndieAuth access
 * tokens (see `@dwk/indieauth`). See `spec/packages/micropub.md`.
 */

/** Cloudflare bindings required by the Micropub handler. */
export interface MicropubEnv {
  /** R2 bucket backing the media endpoint. */
  readonly MEDIA: R2Bucket;
}

/** Configuration passed to {@link createMicropub}. */
export interface MicropubConfig {
  /** The identity root / base URL (e.g. `https://example.com`). */
  readonly baseUrl: string;
}

/** A `fetch`-compatible Worker handler. */
export type MicropubHandler = (
  request: Request,
  env: MicropubEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/**
 * Create the Micropub handler. The returned handler is mountable under a path
 * prefix.
 */
export function createMicropub(_config: MicropubConfig): MicropubHandler {
  return async (_request, _env, _ctx) =>
    new Response("Not Implemented", { status: 501 });
}
