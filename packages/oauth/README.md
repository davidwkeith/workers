# `@dwk/oauth`

> OAuth 2.0 authorization-server building blocks: RFC 8414 metadata, RFC 7662
> introspection, RFC 7009 revocation, RFC 9126 PAR, RFC 7591 dynamic client
> registration. Cross-standard reusable.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/oauth.md) for the full requirements.

This package is **cross-standard reusable**: it takes plain-data inputs only, has
no Workers-runtime dependency (only Web Fetch + Web Crypto), and unit-tests in
isolation (Node, no `workerd`). It is **protocol-agnostic** — no IndieWeb/Solid
claim handling is baked in; the caller supplies issuer/audience policy and the
storage seams. It exists so [`@dwk/indieauth`](../indieauth) and the eventual
Solid-OIDC OP share one audited implementation of these primitives rather than
diverging.

## What it provides

| Endpoint / artifact | RFC | Factory |
| --- | --- | --- |
| Authorization-server metadata | [8414](https://www.rfc-editor.org/rfc/rfc8414) | `buildAuthorizationServerMetadata` |
| Token introspection | [7662](https://www.rfc-editor.org/rfc/rfc7662) | `createIntrospectionHandler` |
| Token revocation | [7009](https://www.rfc-editor.org/rfc/rfc7009) | `createRevocationHandler` |
| Pushed authorization requests | [9126](https://www.rfc-editor.org/rfc/rfc9126) | `createPushedAuthorizationRequestHandler` |
| Dynamic client registration | [7591](https://www.rfc-editor.org/rfc/rfc7591) | `createClientRegistrationHandler` |
| OAuth error registry | [6749 §5.2](https://www.rfc-editor.org/rfc/rfc6749#section-5.2) | `OAuthError`, `oauthErrorResponse` |

## The static / dynamic split

The **metadata document** (`/.well-known/oauth-authorization-server`) is static
JSON derived from config known at build time, so **Anglesite serves it** — no
Worker route is needed merely to publish it. `buildAuthorizationServerMetadata`
is the single source of truth that drives both that static document and any
runtime behaviour that must agree with what was advertised.

The **four POST endpoints** are stateful, so they are the handlers this lib
provides. Each is a path-agnostic `(request) => Promise<Response>` you mount
wherever you like and back with your own strongly-consistent storage.

## Storage is yours (never KV)

This lib owns no database. Token, client, and pushed-request records flow through
the plain-data seams in `./store`, which you back with a strongly-consistent
store (D1 with session consistency, or a Durable Object) via
[`@dwk/store`](../store). Authoritative token/authz state **MUST NOT** live in
KV: a stale introspection or revocation result is a security bug.

## Usage

### Metadata (RFC 8414)

```ts
import { buildAuthorizationServerMetadata } from "@dwk/oauth";

const metadata = buildAuthorizationServerMetadata({
  issuer: "https://example.com",
  authorizationEndpoint: "https://example.com/authorize",
  tokenEndpoint: "https://example.com/token",
  introspectionEndpoint: "https://example.com/introspect",
  revocationEndpoint: "https://example.com/revoke",
  pushedAuthorizationRequestEndpoint: "https://example.com/par",
  registrationEndpoint: "https://example.com/register",
  scopesSupported: ["read", "write"],
  dpopSigningAlgValuesSupported: ["ES256"],
});
```

Endpoint URLs and optional value lists are emitted only when supplied, so the
document never advertises an endpoint you did not mount.

### Introspection (RFC 7662)

```ts
import { createIntrospectionHandler } from "@dwk/oauth";

const introspect = createIntrospectionHandler({
  // Required: the endpoint MUST be protected against token scanning.
  authenticate: (request) => verifyResourceServer(request),
  // Look the token up in your strongly-consistent store.
  lookupToken: async (token) => store.findToken(token),
});

// active → mapped RFC 7662 claims (snake_case), inactive → { active: false }.
const response = await introspect(request);
```

A DPoP-bound token surfaces its key thumbprint as `cnf: { jkt }`. The `active`
flag is derived from the record's `revoked`/`expiresAt`/`notBefore` (or an
explicit `active` field). `isTokenActive` and `buildIntrospectionResponse` are
exported as pure helpers.

### Revocation (RFC 7009)

```ts
import { createRevocationHandler } from "@dwk/oauth";

const revoke = createRevocationHandler({
  revokeToken: async (token) => store.revoke(token), // MUST be idempotent
  // authenticate is optional — omit for public clients using `none`.
});
```

Revocation always returns `200` (even for an unknown token), so a client can
retry safely and cannot probe token existence by status code.

### Pushed authorization requests (RFC 9126)

```ts
import {
  createPushedAuthorizationRequestHandler,
  parseRequestUri,
} from "@dwk/oauth";

const par = createPushedAuthorizationRequestHandler({
  saveRequest: async (record) => store.savePushedRequest(record),
  validate: (params) => (params.code_challenge ? null : "PKCE required"),
  lifetimeSeconds: 60,
  dpopBinding: true, // verify a DPoP proof at PAR and record its jkt
  endpoint: "https://example.com/par",
});
// → 201 { request_uri, expires_in }
```

At the **authorization endpoint** (in your package), recover and single-use the
reference:

```ts
const reference = parseRequestUri(url.searchParams.get("request_uri")!);
const pushed = reference ? await store.consumePushedRequest(reference, now) : null;
```

The `authenticate` hook is `(request, clientId?) => boolean | Promise<boolean>`:
the handler parses the body, hands the extracted `client_id` to the hook, and
passes a **pre-parse clone** of the request, so an authenticator can read the
body itself (e.g. a `client_secret_post` credential) without disturbing the
handler's own parse. This is what lets a PAR authenticator enforce the RFC 9126
§2.1 requirement that the authenticated client match the request's `client_id`.

### Dynamic client registration (RFC 7591)

```ts
import { createClientRegistrationHandler } from "@dwk/oauth";

const register = createClientRegistrationHandler({
  saveClient: async (record) => store.saveClient(record),
  // authenticate is optional (gate open registration with an initial token).
  redirectUriPolicy: (uri) => uri.startsWith("https://"),
});
// → 201 client information response with the issued client_id (+ secret).
```

Validation is strict on the security-relevant fields (`redirect_uris`,
`token_endpoint_auth_method`, the `authorization_code` ⇔ `code` pairing) and
ignores unrecognized members rather than echoing arbitrary client-supplied data
back. `validateClientMetadata` is exported as a pure helper.

## Errors

`OAuthError` is the registered error-code registry; `oauthErrorResponse(code,
description?, status?, headers?)` builds the RFC 6749 §5.2 JSON body. `code` is
typed to the registry, so a non-registered code (the kind that breaks
standards-compliant clients) cannot be emitted by accident.

## Out of scope

- The authorization and token endpoints themselves (those are
  [`@dwk/indieauth`](../indieauth) / the future OP, which compose this lib).
- Storage (you supply it; see above).
- `DPoP-Nonce` issuance and the `use_dpop_nonce` flow.
- JWK Set hosting and access-token signing/verification.

## License

[ISC](../../LICENSE)
