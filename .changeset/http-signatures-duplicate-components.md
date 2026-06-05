---
"@dwk/http-signatures": patch
---

Reject duplicate covered-component identifiers in RFC 9421 signatures. Both the
signer and verifier now fail when a component identifier appears more than once
in the covered-component list (e.g. `("@method" "@method")`), as RFC 9421 §2/§2.5
requires ("each component identifier MUST occur only once"; building a signature
base over a repeated component MUST error). Verification returns
`components_malformed`; signing throws.
