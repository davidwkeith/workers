---
"@dwk/solid-oidc": patch
---

Construct `CodeStore` once per Worker isolate instead of once per request,
avoiding a redundant D1 schema-check round trip on every `/authorize` and
`/token` call (and skipping it entirely for discovery/JWKS requests, which
never touch it).
