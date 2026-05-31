/**
 * `@dwk/webmention` — injectable `fetch` type.
 *
 * Endpoint discovery, source verification, and sending all perform HTTP I/O.
 * They accept a {@link FetchLike} so callers can inject a stub in tests (no
 * network) and so the package never reaches for a global it didn't receive.
 *
 * @packageDocumentation
 */

/** A minimal, injectable `fetch` signature. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
