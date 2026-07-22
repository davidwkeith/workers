/**
 * `@dwk/safe-fetch` — SSRF-safe outbound fetch and capped body reads.
 *
 * A pure, runtime-agnostic library: no Cloudflare bindings, no Workers
 * runtime dependency, unit-tests entirely under Node. Every `@dwk` package
 * that fetches an attacker- or user-supplied URL routes it through
 * {@link safeFetch} / {@link safeFetchJson} instead of re-deriving its own
 * SSRF guardrails.
 *
 * @see spec/packages/safe-fetch.md
 * @packageDocumentation
 */

export {
  isPrivateOrReservedHost,
  assertPublicUrl,
  safeFetch,
  createTimeoutSignal,
  SsrfError,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  ALLOWED_HOST_EVENT,
  type FetchLike,
  type SsrfReason,
  type AssertPublicUrlOptions,
  type SafeFetchOptions,
  type SafeFetchResult,
} from "./safe-fetch.js";
export { safeFetchJson, type SafeFetchJsonOptions } from "./json.js";
export { readBodyCapped, readBytesCapped, MAX_BODY_BYTES } from "./body.js";
export type { Logger, Metrics } from "@dwk/log";
