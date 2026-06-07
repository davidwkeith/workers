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

## Auth / security

- Tokens issued here are **DPoP-bound** (see [dpop.md](dpop.md)); token
  validation is shared with the Solid Pod Resource Server.
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
