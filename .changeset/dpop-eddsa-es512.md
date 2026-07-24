---
"@dwk/dpop": minor
---

Widen the DPoP proof algorithm allow-list with `EdDSA` (Ed25519, RFC 8037 OKP keys — including the OKP RFC 7638 thumbprint) and `ES512` (P-521 + SHA-512). The spec had marked both "not implemented yet — widen on demand"; Ed25519 in particular is where fediverse client signing is converging. Ed448 stays rejected (`crv_mismatch`) — the Workers runtime has no Web Crypto support for it. Symmetric algorithms and `none` remain excluded.
