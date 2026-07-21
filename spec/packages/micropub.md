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
- Query support: `q=config`, `q=source`, and `q=category` (see
  [Micropub extensions](#micropub-extensions)).

## Event post type (`h=event`)

The endpoint supports the Micropub **event** post type (`h=event`), the
IndieWeb-native event primitive (see the calendar/events thread, issue #167).
An event is created exactly like any other post — `h=event` with `name`,
`start`, `end`, `location`, `category`, and `content` properties — and stored
generically by the post store; no event-specific storage path is needed because
the store is mf2-shaped, so `q=source` round-trips an event's properties
unchanged.

For publishing, the package exports a pure `renderHEvent(mf2)` helper that
serializes a stored event's microformats2 object to canonical **`h-event`**
markup (`p-name`, `dt-start`/`dt-end` as `<time datetime>`, `p-location`,
`p-category`, `e-content`, `u-url`). Per the IndieWeb model the page *is* the
event, so the consuming site embeds this markup; the same record then serializes
outward to `.ics`, AS2 `Event`, and pod RDF (issues #170–#172). The renderer is
runtime-free (plain mf2 in, an HTML string out) and unit-tested for mf2
round-trip; **micropub.rocks** remains the authoritative mf2-parser conformance
gate.

For the calendar-interop layer (issue #170), the package also exports
`hEventToCalendarEvent(mf2)` — the **IndieWeb-specific adapter** from a stored
`h-event` to the canonical `CalendarEvent` model in
[`@dwk/calendar`](calendar.md), which then serializes to `.ics`/JSCalendar. This
adapter lives here, not in `@dwk/calendar`, precisely because that lib is a
cross-standard reusable lib and MUST stay free of IndieWeb assumptions (the hard
constraint in [composition-contract.md](../composition-contract.md)); the
h-event vocabulary knowledge belongs where the mf2 shape is already understood.
It maps `uid` (falling back to `url`) → identity, `name` → title,
`summary`/`content` → description, `dt-start`/`dt-end` → start/end, `location` →
locations, `category` → keywords, and `published`/`updated` → timestamps; it is
pure and unit-tested for the `h-event → CalendarEvent → .ics` round-trip.

## Micropub extensions

Beyond the core protocol the endpoint implements a curated subset of the
[IndieWeb Micropub extensions](https://indieweb.org/Micropub-extensions).
Those extensions are organised there into three **maturity groups** —
`official` (adopted into the spec), `stable` (widely implemented and settled),
and `proposed` (experimental) — and the endpoint mirrors that model: each
extension is tagged with its group and is only advertised and honoured when that
group is enabled.

- **Group toggle.** The `extensions` config (`{ official?, stable?, proposed? }`)
  enables extensions a group at a time. Defaults follow the wiki's maturity:
  `official` and `stable` **on**, `proposed` **off**, so a deployment opts in to
  experimental behaviour explicitly. The already-shipped core commands
  (`mp-slug`, `mp-syndicate-to`) and the core `q=config`/`q=source` queries are
  always available and are not gated.

Currently implemented (all **stable**):

- **Post Status** (`post-status`: `published` | `draft`) and **Visibility**
  (`visibility`: `public` | `unlisted` | `private`). Validated on create and on
  the merged result of an update, so a stored post only ever carries a known
  value; an unrecognised value is rejected `400 invalid_request`. An absent
  property is the extension's documented default (`published` / `public`).
  **Scope of enforcement:** the endpoint *stores and advertises* these — it does
  **not** itself gate reads. Hiding a `draft` from public listings and
  access-controlling a `private` post are the **serving layer's**
  responsibility (the consuming site, or WAC in [`@dwk/solid-pod`](solid-pod.md)).
  This boundary is deliberate: `@dwk/micropub` is a publishing endpoint, not the
  renderer.
- **Supported Vocabulary** (`post-types` in `q=config`). The optional
  `postTypes` config advertises the site's editorial post-type vocabulary
  (`[{ type, name }]`) to clients. Omitted from the response when unset or when
  the `stable` group is off; the store persists posts generically regardless.
- **Category/Tag List** (`q=category`). Returns `{ "categories": [...] }` — the
  distinct string `category` (tag) values across all **live** posts (soft-deleted
  posts are excluded), alphabetised, for client autocomplete. Narrowed by the
  **Limit** (`limit=`) and **Filter** (`filter=`, case-insensitive substring)
  parameters; `limit` is capped server-side. Nested non-string tags (e.g.
  `h-card` objects) are excluded from the list.

Not yet implemented / tracked separately:

- **Query for Post List** (`q=source` with no `url`) with offset pagination is
  handled independently (issue #351 / PR #353), not by this increment.
- Proposed-group extensions (`q=geo`, `q=contact`, `audience`,
  `location-visibility`, and the richer query filters) are off by default and
  unimplemented; they are the roadmap tracked in the extensions issue.

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
