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
- Token lifetime and supported scopes.

## Conformance

- IndieAuth portions of the IndieWeb test ecosystem; interop with real IndieAuth
  clients. See [conformance-and-testing.md](../conformance-and-testing.md).
