/**
 * `@dwk/webmention` — Webmention receiver (async verification queue) and sender.
 *
 * Endpoint package: exports a factory returning a `fetch`-compatible handler,
 * mountable under a path prefix. See `spec/packages/webmention.md`.
 */

/** Cloudflare bindings required by the Webmention handler. */
export interface WebmentionEnv {
  /** Queue used to verify received mentions asynchronously. */
  readonly VERIFICATION_QUEUE: Queue;
}

/** Configuration passed to {@link createWebmention}. */
export interface WebmentionConfig {
  /** The identity root / base URL (e.g. `https://example.com`). */
  readonly baseUrl: string;
}

/** A `fetch`-compatible Worker handler. */
export type WebmentionHandler = (
  request: Request,
  env: WebmentionEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

/**
 * Create the Webmention handler. The returned handler is mountable under a path
 * prefix.
 */
export function createWebmention(_config: WebmentionConfig): WebmentionHandler {
  return async (_request, _env, _ctx) =>
    new Response("Not Implemented", { status: 501 });
}
