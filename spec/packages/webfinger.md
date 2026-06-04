# `@dwk/webfinger`

| | |
|---|---|
| **Type** | endpoint |
| **Ships a DO?** | no |
| **Standard** | [WebFinger (RFC 7033)](https://www.rfc-editor.org/rfc/rfc7033) |
| **Status** | proposed — tracked in [#57](https://github.com/davidwkeith/workers/issues/57) |

Account / resource discovery at `/.well-known/webfinger`. Maps a `resource`
URI (`acct:`, `mailto:`, `https:`) to a JRD of links — avatar, profile page,
OIDC issuer, and the `self` ActivityPub actor. Foundational for federation:
[`@dwk/activitypub`](activitypub.md) discovery depends on it.

## Worker vs. Anglesite (the static split)

WebFinger is **borderline static**. Anglesite (the static site generator) can
already emit a single `/.well-known/webfinger` JRD, and for a **single-identity**
site that often suffices. Spec-correct behaviour, however, needs request logic a
static host cannot do, which is why this package exists:

- **MUST** dispatch on the `resource` query parameter and return **404** for a
  `resource` this server does not control (a static file returns `200` for any
  `resource=`).
- **MUST** echo the matched `subject`, which **MUST** equal the queried
  `resource` URI.
- **SHOULD** filter the returned `links` by any `rel` query parameters.

Document that the degenerate single-resource, no-`rel`-filter case **MAY** remain
a static Anglesite file; the package covers the multi-resource / `rel`-filtered
case correctly.

## Functional requirements

- Export `createWebfinger(config)` returning the standard
  `(request, env, ctx) => Promise<Response>` handler (see
  [composition-contract.md](../composition-contract.md)), mountable at
  `/.well-known/webfinger`.
- Respond with media type `application/jrd+json`.
- `resource` absent → **400**; `resource` unknown → **404**; matched → **200**
  with `subject`, `aliases`, `links`.
- Honor `rel` (repeatable) by returning only matching link relations.
- Emit permissive CORS (`Access-Control-Allow-Origin: *`) per RFC 7033 §10.2 —
  WebFinger is public discovery data.

## Design constraints

- **Stateless.** No DO, no D1: the `resource → JRD` mapping is supplied by
  config (or derived from a profile document via [`@dwk/rdf`](rdf.md)), never
  read from the global environment (composition contract).

## Bindings (declared `Env` fragment)

- None required for the config-supplied mapping. (Optional R2/profile binding
  only if links are derived from stored profile data.)

## Config

- `baseUrl` / domain (the identity root).
- The set of controlled resources and their links (or a resolver function).

## Conformance / testing

- RFC 7033. Interop check against Mastodon / fediverse WebFinger expectations
  (the `subject` must match the queried `resource` URI — any scheme, not only
  `acct:`). Unit-tests under Node with no Workers runtime. See
  [conformance-and-testing.md](../conformance-and-testing.md).
