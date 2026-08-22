---
"@dwk/activitypub": patch
---

Consolidate the outbound-delivery SSRF guard onto `@dwk/safe-fetch`'s
`assertPublicUrl` instead of a second, hand-rolled IPv4/IPv6 check, closing a
bypass where a mapped, 6to4, or Teredo IPv6 address (e.g. `[::ffff:127.0.0.1]`)
was not recognized as private. The Durable Object's `#resolveInbox` and
`#processVerifications` fetches now route through `safeFetch` as well, so a
redirect on an already-validated target is re-validated hop by hop instead of
trusting the initial check alone.
