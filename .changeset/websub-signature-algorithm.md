---
"@dwk/websub": patch
---

Make the `X-Hub-Signature` digest method configurable on the hub. WebSub §7.1
permits `sha1|sha256|sha384|sha512`; the hub previously hard-coded SHA-256 with
no way to interoperate with subscribers expecting another method. A new
`signatureAlgorithm` config option (default `sha256`, the secure choice) lets a
deployment opt into SHA-1 for legacy-subscriber interop, and the distribution
signature is emitted as `<method>=<hex>` for the configured method.
