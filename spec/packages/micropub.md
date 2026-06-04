# `@dwk/micropub`

| | |
|---|---|
| **Type** | endpoint |
| **Ships a DO?** | no |
| **Standard** | [Micropub](https://micropub.spec.indieweb.org/) |

Publishing endpoint. Consumes IndieAuth access tokens for authorization.

## Functional requirements

- **Create / update / delete** actions.
- Accept both `application/json` and **form-encoded** request bodies.
- **Media endpoint** backed by **R2**.
- Query support: `q=config` and `q=source`.

## Auth / security

- Authorize via an **IndieAuth access token + scope** (see
  [indieauth.md](indieauth.md)). The token's scope gates which actions are
  permitted.
- **Subject (`me`) binding.** A Micropub endpoint serves a single user's site,
  so the token's subject (`sub`, the canonical `me`) MUST equal the configured
  owner `me` (after canonicalization). Otherwise any token minted by the same
  issuer for a *different* `me` carrying the right scope could publish here — an
  authorization bypass in any multi-user or shared-issuer deployment.
- Tokens are DPoP-bound; validation reuses [`@dwk/dpop`](dpop.md).

## Bindings (declared `Env` fragment)

- **R2 bucket** for the media endpoint.
- Storage for published content / post records (D1 accessed with session
  consistency, or R2, per the consuming app's model). Authoritative state in
  strongly-consistent stores only — not KV.

## Config

- `baseUrl` / domain.
- `me` — the site owner's IndieAuth profile URL. Required; tokens whose subject
  is not this `me` are rejected.
- Media bucket binding name and any size thresholds.
- Mapping/policy for where created posts are stored.

## Conformance

- [micropub.rocks](https://micropub.rocks/) and publish an entry in the
  [implementation reports](https://micropub.net/implementation-reports/). See
  [conformance-and-testing.md](../conformance-and-testing.md).
