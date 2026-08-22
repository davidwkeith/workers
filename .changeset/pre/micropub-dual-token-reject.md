---
"@dwk/micropub": patch
---

Reject a request that transmits the access token in both the `Authorization`
header and the request body with `invalid_request` (HTTP 400), as required by
RFC 6750 §2 ("clients MUST NOT use more than one method to transmit the token").
Header-only and body-only token transmission are unchanged.
