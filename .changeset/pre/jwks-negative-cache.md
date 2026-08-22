---
"@dwk/solid-pod": patch
"@dwk/remotestorage": patch
---

Negative-cache a failed JWKS fetch so a token burst can't hammer the issuer
(#304). On a JWKS fetch failure (non-ok, malformed body, or thrown) with no
cached keys, `resolveJwks` returned without recording the failure, so every
presented-token request re-fetched the JWKS URI — an amplification/DoS vector
against the issuer's endpoint while it is down. A failed fetch is now recorded
with a short backoff (30s): within the window the last good keys are served if
available (else the request is rejected), but the issuer is not re-hit on every
request.
