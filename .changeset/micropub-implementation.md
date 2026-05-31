---
"@dwk/micropub": minor
---

Implement `@dwk/micropub`: a Micropub publishing endpoint that accepts JSON,
form-encoded, and `multipart/form-data` requests; supports create/update/delete/
undelete actions and the `q=config`/`q=source`/`q=syndicate-to` queries; and
ships an R2-backed media endpoint that streams uploads and serves them back.
Published posts are stored as microformats2 source in D1 (strongly consistent,
never KV). Every request is authorized by a DPoP-bound IndieAuth access token —
verified with `@dwk/indieauth`'s `verifyAccessToken`, bound via `@dwk/dpop`, and
checked for revocation against the shared issued-token store — with the token's
scope gating the action. The handler is mountable under any path prefix and
fails loudly if the `MEDIA`, `MICROPUB_DB`, `AUTH_DB`, or `TOKEN_SIGNING_KEY`
bindings are missing.
