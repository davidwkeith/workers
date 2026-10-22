---
"@dwk/micropub": patch
"@dwk/microsub": patch
---

Accept the same access token sent in both the `Authorization` header and the `access_token` parameter, as Quill sends every post; only two different tokens are still rejected 400. A malformed `multipart/form-data` body to the Micropub endpoint now gets `400 invalid_request` instead of a 500.
