# @dwk/oauth

## 0.1.0-beta.4

### Minor Changes

- 7b4349c: Add the `ClientStore` seam — `getClient(clientId)` alongside `saveClient` — so
  consumers building authorize/token grants over the RFC 7591 registration
  handler can verify redirect URIs and client secrets through one interface.

### Patch Changes

- 3e505be: Dynamic client registration (`registration.ts`) no longer echoes untrusted
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

- bde0341: Never persist client-authentication credentials into the stored PAR record
  (#295). The Pushed Authorization Request handler copied every form field into
  the saved `PushedRequestRecord.params`, so a client authenticating with
  `client_secret_post` (or `private_key_jwt`) had its `client_secret` /
  `client_assertion` written into the request store at rest. The handler now
  strips `client_secret`, `client_assertion`, and `client_assertion_type` before
  saving, keeping only the authorization parameters (RFC 9126).
- 36a3be1: Reject request bodies with a duplicated parameter (#308). `readForm` kept the
  last occurrence of a repeated key while an `EndpointAuthenticator` reading the
  cloned body sees the first (`FormData.get`), so two `client_id`s could
  authenticate as one client but be attributed to another. Per RFC 6749 §3.2,
  `readForm` now returns `null` on any duplicate and the introspection, revocation,
  and PAR handlers reject it with `invalid_request`.
- Updated dependencies [3e505be]
  - @dwk/log@0.1.0-beta.4

## 0.1.0-beta.3

### Patch Changes

- Updated dependencies [6d14fc3]
  - @dwk/dpop@0.1.0-beta.3
  - @dwk/log@0.1.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/dpop@0.1.0-beta.2
  - @dwk/log@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/dpop@0.1.0-beta.1
  - @dwk/log@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- 99a90b3: Add `@dwk/oauth` — the shared OAuth 2.0 authorization-server building blocks. A
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

### Patch Changes

- Updated dependencies [cdda653]
- Updated dependencies [171749e]
- Updated dependencies [28a1693]
- Updated dependencies [65cab2c]
- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
  - @dwk/dpop@0.1.0-beta.0
  - @dwk/log@0.1.0-beta.0
