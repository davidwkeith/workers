---
"@dwk/indieauth": minor
---

Implement `@dwk/indieauth`: the authorization-code + PKCE flow, a D1-backed
single-use authorization-code and issued-token store, DPoP-bound HS256 access
tokens (bound via `@dwk/dpop`'s `cnf.jkt` and validatable by the Resource
Server), profile-URL (`rel=me`) verification helpers, RFC 7009 revocation, and a
discoverable OAuth 2.0 / IndieAuth server-metadata document. Authentication and
consent are delegated to the deployer via `approveAuthorization`; authorization
state lives in D1 (strongly consistent, never KV) and the handler fails loudly
if the `AUTH_DB` or `TOKEN_SIGNING_KEY` bindings are missing.
