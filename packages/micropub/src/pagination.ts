/**
 * Offset-based list-query pagination: parsing and validating client-supplied
 * `limit`/`offset` query parameters into a bounded {@link PageRequest}. Pure
 * and protocol-runtime-free, so any future list-style query can reuse the same
 * parsing and bounds without re-deriving validation.
 */

/** A validated offset-based page request: always within bounds. */
export interface PageRequest {
  /** Number of items to return; always in `[1, MAX_LIMIT]`. */
  readonly limit: number;
  /** Number of items to skip; always `>= 0`. */
  readonly offset: number;
}

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;

/**
 * Parse `limit`/`offset` from search params into a bounded {@link PageRequest}.
 * A missing, non-numeric, or out-of-range value falls back to the default
 * rather than erroring — pagination parameters are a client convenience, not a
 * contract a malformed value should 400 over.
 */
export function parsePageRequest(params: URLSearchParams): PageRequest {
  const limitRaw = Number.parseInt(params.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const offsetRaw = Number.parseInt(params.get("offset") ?? "", 10);
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  return { limit, offset };
}
