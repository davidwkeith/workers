---
"@dwk/solid-pod": patch
"@dwk/activitypub": patch
"@dwk/webfinger": patch
---

Close three gaps found in a Cloudflare Workers best-practices audit:

- `@dwk/solid-pod`: `PATCH` now checks WAC Append authorization (which every
  patch requires; `Write` implies `Append`) _before_ buffering or parsing the
  request body, and caps the read at `store.maxInlineBytes` (413 on overflow)
  instead of an unbounded `request.text()`. Previously any caller — even an
  unauthenticated one — could force the single-threaded per-pod Durable
  Object to buffer and N3-parse an arbitrarily large body before any
  permission check ran.
- `@dwk/activitypub`: `deliverActivity`'s outbound `POST` now routes through
  `@dwk/safe-fetch`'s `safeFetch` instead of a bare `fetch`, so redirect hops
  get the same SSRF re-validation as the pre-flight target check. A hostile
  inbox that 3xx-redirects a signed delivery to a private/internal target is
  now rejected the same way an unsafe initial target already was (dropped,
  not retried).
- `@dwk/webfinger`: `resolveHandle` now reads the WebFinger response through
  `readBodyCapped` (2 MB default) before parsing it as JSON, instead of an
  unbounded `response.json()` — a malicious or compromised host could
  otherwise return an arbitrarily large body.
