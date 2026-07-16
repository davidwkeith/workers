# @dwk/safe-fetch

SSRF-safe outbound fetch and capped body reads, shared across every `@dwk`
package that fetches an attacker- or user-supplied URL.

Provides:

- `safeFetch` / `safeFetchJson` — private/reserved-host blocking (including
  the RFC 7686 `.onion` special-use TLD, unreachable from Workers), bounded
  manual redirects with per-hop re-validation, a single overall timeout, and
  cross-origin credential-header stripping on redirect.
- `readBodyCapped` / `readBytesCapped` — a response body reader that refuses
  to buffer past a byte cap, ignoring a lying `Content-Length`.

## Local development (`allowedHosts`)

The host block is deny-by-default. For local debugging only (e.g. a composed
Worker under `wrangler dev --local` fetching the dev site it sits next to),
`allowedHosts` accepts **exact** `host[:port]` entries (case-insensitive,
bracketed IPv6) exempted from the private/loopback block:

```ts
await safeFetch(fetch, "http://localhost:4321/post", init, {
  allowedHosts: ["localhost:4321"],
});
```

Scheme checks, redirect caps (each hop re-validated against the same list),
timeouts, and body caps still apply. Never enable this in a production
composition — inject it only into local-dev config, never from the
environment. Every use is logged/counted as `safe_fetch.ssrf.allowed_host`
(`ALLOWED_HOST_EVENT`). Consuming packages expose it as `fetchAllowedHosts`
in their options/config.

See `spec/packages/safe-fetch.md` for the full contract.
