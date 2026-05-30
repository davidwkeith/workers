/**
 * `@dwk/indieauth` — IndieAuth authorization, token, and metadata endpoints.
 *
 * Endpoint package: exports a factory returning a `fetch`-compatible handler,
 * mountable under a path prefix so it composes with other `@dwk` packages in
 * one Worker. See `spec/packages/indieauth.md`.
 */

/** Cloudflare bindings required by the IndieAuth handler. */
export interface IndieAuthEnv {
  /** Signing key material for issued tokens (secret binding). */
  readonly TOKEN_SIGNING_KEY: string;
}

/** Configuration passed to {@link createIndieAuth}. */
export interface IndieAuthConfig {
  /** The identity root / base URL (e.g. `https://example.com`). */
  readonly baseUrl: string;
  /** The token issuer identifier. */
  readonly issuer: string;
}

/** A `fetch`-compatible Worker handler. */
export type IndieAuthHandler = (
  request: Request,
  env: IndieAuthEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/**
 * Create the IndieAuth handler. The returned handler is mountable under a path
 * prefix.
 */
export function createIndieAuth(_config: IndieAuthConfig): IndieAuthHandler {
  return async (_request, _env, _ctx) =>
    new Response("Not Implemented", { status: 501 });
}
