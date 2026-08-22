---
"@dwk/indieauth": patch
---

Require the `state` authorization-request parameter and always echo it. The
IndieAuth authorization endpoint now rejects a request with a missing or empty
`state` as `invalid_request` (once `redirect_uri`/`client_id` are validated, via
the same redirect-error path as the missing-PKCE case) and sets `state` on both
success and error redirects unconditionally, closing a CSRF-defense gap where
`state` was treated as optional.
