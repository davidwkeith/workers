---
"@dwk/dpop": minor
---

Implement `@dwk/dpop` — DPoP (RFC 9449) proof verification. A pure,
runtime-agnostic `verifyDpopProof` that checks the JOSE header (`dpop+jwt`
`typ`, asymmetric `alg` allow-list, public-only `jwk`), the signature, and the
`htm`/`htu`/`iat`/`jti` claims; computes the RFC 7638 `jkt` thumbprint; and
supports the Resource Server `ath` and `cnf.jkt` bindings.
