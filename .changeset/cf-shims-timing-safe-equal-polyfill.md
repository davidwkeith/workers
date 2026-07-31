---
"@dwk/cf-shims": patch
---

Add `installTimingSafeEqual`, a Node polyfill for
`crypto.subtle.timingSafeEqual`. That method is a real, synchronous
`SubtleCrypto` extension but is Cloudflare-Workers-proprietary — it does not
exist on Node or Deno. `@dwk/indieauth`, `@dwk/webauthn`, `@dwk/mastodon-api`,
and `@dwk/conformance-target` all use it for constant-time PKCE/HMAC/
challenge/client-secret comparisons, so without this shim every package
composed into `@dwk/server` (the Node self-hosting host) that reaches one of
those code paths throws a `TypeError`. The polyfill is a pure-JS
constant-time XOR-accumulator comparison, idempotent (installed via `??=`,
matching `installCryptoDigestStream`'s pattern) and a no-op wherever a native
implementation already exists.
