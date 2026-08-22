---
"@dwk/oauth": minor
---

Add `@dwk/oauth` — the shared OAuth 2.0 authorization-server building blocks. A
pure, runtime-agnostic cross-standard reusable (plain-data storage seams, Web
Fetch + Web Crypto only, Node-testable) sitting alongside `@dwk/dpop`, factoring
out the server primitives `@dwk/indieauth` partly implements so the eventual
Solid-OIDC OP can share one audited implementation.

- **RFC 8414** `buildAuthorizationServerMetadata` — config→JSON metadata
  document, the single source of truth shared with the static document Anglesite
  publishes; endpoints/value-lists are emitted only when configured.
- **RFC 7662** `createIntrospectionHandler` — protected against token scanning
  (authentication required), derives `active` from `revoked`/`exp`/`nbf`, maps to
  the snake_case response, and surfaces DPoP `cnf.jkt`.
- **RFC 7009** `createRevocationHandler` — idempotent, always `200`.
- **RFC 9126** `createPushedAuthorizationRequestHandler` — single-use
  `request_uri` with expiry, optional DPoP binding via `@dwk/dpop`, plus
  `parseRequestUri`/`requestUriFor` helpers for the consume side.
- **RFC 7591** `createClientRegistrationHandler` — strict metadata validation
  (`redirect_uris`, `token_endpoint_auth_method`, grant/response-type pairing)
  with `client_id`/secret issuance.
- A shared, registered **OAuth error registry** (`OAuthError` /
  `oauthErrorResponse`) so a non-registered `error` code cannot be emitted.

Storage stays in the consuming endpoint package (strongly-consistent D1/DO via
`@dwk/store`, never KV); this lib owns only the protocol mechanics and stays
protocol-agnostic (no IndieWeb/Solid claim handling).
