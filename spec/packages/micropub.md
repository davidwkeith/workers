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
- Tokens are DPoP-bound; validation reuses [`@dwk/dpop`](dpop.md). `@dwk/dpop`
  proves a proof fresh but delegates **replay** detection to the caller
  (RFC 9449): each accepted proof `jti` is recorded in a strongly-consistent,
  short-TTL store (D1), and a duplicate is rejected, so a captured proof cannot
  be replayed within its acceptance window to repeat a state-changing request.
- **DPoP is mandatory** for every authenticated request, including queries and
  the media endpoint. Although the token may be supplied either via the
  `Authorization` header or, per [Micropub §5.2][mp-auth], a form-encoded
  `access_token` body parameter, in **all** cases a matching `DPoP` proof header
  is required and a request without one is rejected `401 invalid_request`. This
  is stricter than the Micropub/OAuth baseline, which permits a plain Bearer
  token with no proof of possession: it is the deliberate "DPoP everywhere"
  posture mandated by [non-functional-requirements.md](../non-functional-requirements.md)
  ("DPoP everywhere tokens are used"), so a stolen bearer token alone is never
  sufficient to act on the endpoint. The practical consequence is that
  bearer-only clients — including micropub.rocks' default (non-DPoP) token flow
  — cannot authenticate against this endpoint; conformance is asserted only for
  DPoP-capable clients. This is an intentional deviation, not a defect.

[mp-auth]: https://www.w3.org/TR/micropub/#authentication
- **Least privilege.** The media endpoint requires the dedicated `media` scope;
  a `create`-only token authorizes creating posts (including photos folded into
  a multipart create) but not arbitrary blob uploads to the media endpoint.

## Error responses

Error bodies use the Micropub/OAuth shape
`{ "error": string, "error_description": string }` with the error codes from
the [Micropub error table][mp-errors]
(`invalid_request`, `unauthorized`, `insufficient_scope`, `forbidden`, …) and
their mapped HTTP statuses (`invalid_request` → 400, `unauthorized` → 401, and
so on).

- **Missing-post `404`s are a deliberate extension.** When an action or query
  targets a URL that has no post (`q=source`, `update`, `delete`, `undelete` on
  a non-existent or already-deleted URL), the endpoint responds `404 Not Found`
  even though the error code in the body is `invalid_request`. The Micropub and
  OAuth error registries have **no `not_found` code**, so there is no
  spec-registered code that pairs naturally with a 404; rather than mislabel the
  condition or downgrade a genuine "resource does not exist" to the 400 the
  error table would otherwise imply, the endpoint keeps the semantically correct
  `404` status and reuses the nearest registered error code. This pairing is
  intentional and exercised by the test suite; it is the one place the body
  code and HTTP status intentionally diverge from the error table.

[mp-errors]: https://www.w3.org/TR/micropub/#error-response

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
