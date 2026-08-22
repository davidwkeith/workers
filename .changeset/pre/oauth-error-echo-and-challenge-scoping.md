---
"@dwk/oauth": patch
---

Dynamic client registration (`registration.ts`) no longer echoes untrusted
submitted values (`token_endpoint_auth_method`, `grant_types`,
`response_types`, `redirect_uris`) back into `error_description`, matching
`errors.ts`'s own documented rule against untrusted echoes. `readJson` now
caps the request body at 64 KiB, read incrementally, so an oversized
submission under open registration is abandoned instead of buffered in full.

Introspection, revocation, PAR, and registration now scope their `401`
`WWW-Authenticate` challenge to the scheme the request actually attempted
(`Basic` for a `client_secret_basic` caller sending `Authorization: Basic
...`) instead of unconditionally asserting `Bearer`, which was simply wrong
for a Basic-authenticating client.
