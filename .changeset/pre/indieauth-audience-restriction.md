---
"@dwk/indieauth": minor
---

Add audience-restricted access tokens (RFC 8707 resource indicators / RFC 9700
§2.3). Clients may now supply one or more `resource` parameters on the
authorization request (and narrow them on the token request); the issued token
then carries an `aud` claim naming the resource server(s) it may be presented
to, so a token leaked to one resource server cannot be replayed at another. Each
`resource` must be a well-formed absolute URI and pass the new optional
`resourceIndicatorPolicy` config hook (defaults to accepting any well-formed
resource); an unacceptable value is rejected with `invalid_target`. The audience
is bound at authorization and may only be narrowed at the token endpoint.

`verifyAccessToken` gains an optional `audience` option: when set, the token MUST
carry an `aud` including that resource-server identifier, otherwise verification
fails with the new `audience_mismatch` reason. Tokens with no `aud` and callers
that pass no expected `audience` are unaffected, so this is backward compatible.

The store's `init()` now performs an idempotent column migration (`ALTER TABLE
... ADD COLUMN resource`, guarded by `PRAGMA table_info`) so a durable D1
database created before this change gains the new column instead of crashing
with `no such column: resource`.

Also clarifies (in docs only) that the IndieAuth "MUST contain a path component"
rule for `client_id`/profile URLs is satisfied by construction — WHATWG URL
parsing always yields at least a `/` path, which the spec accepts — so no
explicit non-root check is applied.
