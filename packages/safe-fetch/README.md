# @dwk/safe-fetch

SSRF-safe outbound fetch and capped body reads, shared across every `@dwk`
package that fetches an attacker- or user-supplied URL.

Provides:

- `safeFetch` / `safeFetchJson` — private/reserved-host blocking, bounded
  manual redirects with per-hop re-validation, a single overall timeout, and
  cross-origin credential-header stripping on redirect.
- `readBodyCapped` / `readBytesCapped` — a response body reader that refuses
  to buffer past a byte cap, ignoring a lying `Content-Length`.

See `spec/packages/safe-fetch.md` for the full contract.
