---
"@dwk/safe-fetch": patch
---

Block 6to4 and Teredo IPv6 addresses that embed a private IPv4 (#298).
`isPrivateOrReservedHost` already rejected IPv4-mapped / NAT64 forms, but not
`2002::/16` (6to4 — the embedded IPv4 is groups 1–2, e.g. `2002:7f00:1::` carries
`127.0.0.1`) or `2001:0000::/32` (Teredo — the client IPv4 is groups 6–7,
bitwise-inverted). Both are now decoded and rejected when the embedded IPv4 is
private/reserved, closing an SSRF bypass through those transition formats while
still allowing 6to4/Teredo addresses that wrap a public IPv4.
