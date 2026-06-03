---
"@dwk/webmention": patch
---

Harden every outbound fetch against SSRF. Source verification, endpoint
discovery, and sender notification now route through a shared `safeFetch`
wrapper that rejects private/loopback/link-local/reserved hosts (including the
`169.254.169.254` cloud metadata IP, IPv4-mapped IPv6, and names like
`localhost`/`*.internal`), follows redirects manually while re-validating the
host on every hop and capping the hop count, and bounds the whole request with
a timeout. Exports `safeFetch`, `assertPublicUrl`, `isPrivateOrReservedHost`,
and `SsrfError`.
