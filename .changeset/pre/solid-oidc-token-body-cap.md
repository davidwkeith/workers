---
"@dwk/solid-oidc": patch
---

Cap the token endpoint's form-body read at 8 KiB before PKCE/code/DPoP
validation runs, instead of buffering an unbounded body on this public,
unauthenticated endpoint.
