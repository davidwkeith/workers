---
"@dwk/safe-fetch": patch
---

Block the RFC 7686 `.onion` special-use TLD in `isPrivateOrReservedHost` /
`assertPublicUrl`. Workers cannot reach Tor onion services, so a peer-supplied
`.onion` URL now fails up front as a structured `blocked_host` `SsrfError`
instead of an opaque network error at fetch time.
