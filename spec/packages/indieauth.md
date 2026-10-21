# `@dwk/indieauth`

| | |
|---|---|
| **Type** | endpoint |
| **Ships a DO?** | no |
| **Standard** | [IndieAuth](https://indieauth.spec.indieweb.org/) |

The IndieAuth identity layer rooted at the user's domain. Issues the access
tokens that `@dwk/micropub` (and other clients) consume.

## Functional requirements

- Implement the **authorization**, **token**, and **metadata** endpoints.
- **PKCE is required** on the authorization code flow.
- Support `rel=me` / **profile-URL verification**.
- Issue **scopes**, consumed downstream by Micropub.

## Implementing consent

The library owns all protocol mechanics; authenticating the user and obtaining
consent is the deployer's concern, delegated through the required
`approveAuthorization` config hook (`ApproveAuthorization` in
`packages/indieauth/src/config.ts`). The hook receives the parsed, **validated**
authorization request plus the raw HTTP `Request` and returns either an
approval (`{ me, scopes?, profile? }`) — the library mints the code and
redirects — or a `Response` the library returns unchanged (a consent page, a
redirect to an external IdP, …).

- **The hook fires on `GET /authorize` only.** `POST /authorize` is
  unconditionally the IndieAuth **profile-URL redemption grant** (code → `me`),
  so a consent form MUST NOT post back to the authorization endpoint — the
  submission would be parsed as a redemption attempt and rejected. Consent
  submission lives on a deployer-owned endpoint, and the flow completes by
  re-entering `GET /authorize`.
- **Redirect-with-token (recommended):** the hook renders a form posting to a
  deployer endpoint (e.g. `POST /consent`); that endpoint authenticates the
  user and 303-redirects back to `GET /authorize` with the original
  authorization params plus a **signed, short-TTL consent token**; on re-entry
  the hook verifies the token — recomputing the signature over the _validated_
  request fields (`clientId`, `redirectUri`, `state`, `codeChallenge`, plus the
  granted `scopes`/`resources`, since the approval defaults to the requested
  scopes and an unsigned `scope`/`resource` param altered after consent would
  silently widen the grant), not the raw query, so the token vouches for
  exactly what will be granted — and returns the approval. Reference
  implementation: `packages/conformance-target/src/approval.ts` (a
  fixed-behavior test identity that signs only the request-identity fields; a
  real IdP MUST cover the grant fields too).
- **Session cookie:** the hook checks a session cookie; if absent or invalid it
  takes over with a login redirect whose post-login destination is the original
  `GET /authorize` URL; if present it returns the approval (optionally after a
  consent interstitial that itself redirects back).

## Auth / security

- Tokens issued here are **HS256**, self-issued with a shared secret, and
  **DPoP-bound** (see [dpop.md](dpop.md)); `verifyAccessToken` validation is
  shared with Micropub and other resource servers that accept these tokens.
  `@dwk/solid-pod` is not one of them — its Resource Server validates
  asymmetrically-signed Solid-OIDC tokens (issuer JWKS, `webid` claim) from the
  separate [`@dwk/solid-oidc`](solid-oidc.md) OP instead; see
  [open-questions.md §1](../open-questions.md#1-solid-oidc-op--resolved).
- **Opt-in Bearer tokens** (`bearerTokens`, off by default; the designed
  exception in [non-functional-requirements.md](../non-functional-requirements.md)
  § Security). When set and a token request carries **no** `DPoP` header, the
  token endpoint issues an unbound RFC 6750 token: no `cnf` claim,
  `token_type: "Bearer"`, the granted scope narrowed to `bearerTokens.scopes`
  (default `scopesSupported`; none left is `invalid_scope`), and a lifetime of
  `bearerTokens.lifetimeSeconds` (default, and capped at,
  `accessTokenLifetimeSeconds`). It is recorded in the token store with an
  empty `jkt`, so revocation applies. A request that sends a proof is always
  verified against it — an invalid proof is `invalid_dpop_proof`, never a
  downgrade. `verifyAccessToken` accepts a token without `cnf`; each resource
  server decides whether to (`acceptBearerTokens` in micropub/microsub, never
  in `@dwk/mcp`).
- **Token introspection** (RFC 7662; [IndieAuth §6.1](https://indieauth.spec.indieweb.org/#access-token-verification)),
  opt-in via `authorizeIntrospection(request)`: IndieAuth requires the endpoint
  to demand authorization, so it is served (default `/introspect`) and
  advertised as `introspection_endpoint` only when the deployer supplies that
  hook. A request the hook refuses is `401`. An active token — valid
  signature, issuer, and time window, and live in the token store — returns
  `active: true` with `me`, `client_id`, `scope`, `exp`, `iat`, `token_type`
  (`DPoP` or `Bearer`), `aud` when restricted, and `cnf.jkt` when DPoP-bound
  (RFC 9449 §6.2), so the resource server still completes the binding.
  Anything else is `{"active": false}` with no reason.
- The metadata always sets `authorization_response_iss_parameter_supported:
  true`: the authorization response carries `iss` (RFC 9207).
- Support **audience-restricted** access tokens (RFC 8707 resource indicators /
  RFC 9700 §2.3): when a client supplies `resource` parameter(s), the issued
  token carries an `aud` claim, and resource servers verify it against their own
  identifier, so a token leaked to one resource server cannot be replayed at
  another. DPoP's `cnf.jkt` mitigates but does not replace this. The audience is
  bound at authorization (where consent happens) and may only be narrowed at the
  token request; an unacceptable `resource` is rejected with `invalid_target`.
- Publish a metadata endpoint sufficient for clients to discover the
  authorization/token endpoints and supported PKCE methods.

## Bindings (declared `Env` fragment)

- Storage for authorization codes / issued tokens. Codes are short-lived;
  authoritative token state MUST live in a strongly-consistent store (a DO, or
  D1 accessed with session consistency), never KV (see
  [non-functional-requirements.md](../non-functional-requirements.md#consistency-rules-load-bearing)).
- Signing key material as a secret binding.

## Config

- `baseUrl` / domain (the identity root).
- `issuer`.
- Allowed client origins / redirect policy.
- Resource-indicator policy (which RFC 8707 `resource` values may audience-restrict a token).
- Token lifetime and supported scopes.

## Conformance

- IndieAuth portions of the IndieWeb test ecosystem; interop with real IndieAuth
  clients. See [conformance-and-testing.md](../conformance-and-testing.md).
