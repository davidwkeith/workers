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
- Query support: `q=config`, `q=source` (single post and list), and `q=category`
  (see [Micropub extensions](#micropub-extensions) and [Query support](#query-support)).

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
  parameters; `limit` is capped server-side. An absent or malformed `limit`
  returns the full (capped) list rather than a default page — autocomplete
  wants every tag — a deliberate difference from the post-list query's
  paginated default. Nested non-string tags (e.g. `h-card` objects)
  are excluded from the list.
- **Post List** (`q=source` without a `url`) — the caller's live posts
  newest-first, with `limit`/`offset` pagination (#351/#353). Fully
  specified under [Query support](#query-support) below.

## Query support

### `q=source`

The spec defines `q=source` with a required `url` parameter: fetch and return a
single post. This endpoint extends that with a widely-implemented Micropub
extension ([Micropub-extensions#Query-for-post-list][mp-ext-list]):

- **Single post** (`?q=source&url=<URL>`): returns `{ "type": [...], "properties": {...} }`
  (full mf2 object).
- **List** (`?q=source` without `url`): returns `{ "items": [...] }` where each item is
  a full mf2 object, ordered newest-first by creation time. Supports offset-based
  pagination via the `limit` (default 10, max 100) and `offset` (default 0) parameters.

Both forms support the `properties[]` parameter to filter which properties are
returned per item (e.g., `?q=source&properties[]=content` returns only the
`content` property, if present).

Only **soft-deleted** posts — those removed via the `delete` action (the
`deleted` flag) — are excluded from the list, and a single-post query targeting
one returns `404`. Drafts (`post-status: draft`) are **not** soft-deleted: they
appear in the list and resolve normally on a single-post query. That is
deliberate — a draft never appears in the built site, so this authenticated list
is a client's only way to browse its own drafts (#351).

[mp-ext-list]: https://indieweb.org/Micropub-extensions#Query_for_Post_List

### Proposed Contacts (`q=contact`)

Contacts are an opt-in proposed extension: it is advertised in `q=config` and
routed only when `extensions.proposed` is true and a `contacts` store/provider
is configured. It is private owner data, so every request uses the existing
IndieAuth subject binding and mandatory DPoP validation. Reads require an
authenticated token but no particular action scope (intentionally matching
`q=source`); create, update, and delete require their corresponding Micropub
scopes.

`GET ?q=contact` returns `{ "contacts": [...] }`, with h-card value objects
and response-only `_internal_url` management handles. `filter` (or compatibility
alias `search`) is a case-insensitive literal substring match across strings in
known and unknown properties. Results have deterministic display-name ordering,
with `limit` (1–100, default 100) and `offset` pagination.

`POST ?q=contact` creates an `h-card` from JSON, form-encoded, or multipart
input; multipart files are streamed to R2 and folded into their matching h-card
properties. `action=update` uses standard JSON replace/add/delete operations
against `_internal_url`; and `action=delete` hard-deletes it. Contacts preserve
arbitrary property arrays and structured values. A non-empty `name`,
`nickname`, `url`, or `email` is required; the canonical first http(s) URL is
unique among contacts. To person-tag a post, a client copies the selected
h-card (not `_internal_url`) into `category` as an embedded h-card, preserving
a historical snapshot.

The built-in `createMicropubContactStore` creates a separate strongly-consistent
D1 table with bound queries and indexes; custom stores implement the same
`MicropubContactStore` seam. KV is never an authoritative contact store.

### Proposed Audience and Location Visibility

The IndieWeb extensions reference reserves the `audience` and
`location-visibility` property names, but leaves their detailed mf2 payload
shapes open. This package defines a deliberately small, client-operable
contract for both. It is enabled only with `extensions: { proposed: true }`;
with the default setting (`false`) neither capability is advertised or
interpreted, preserving the existing generic-mf2 behavior.

- **Audience** is a multi-valued mf2 property of stable string IDs:
  `"audience": ["family", "project-alpha"]`. The deployment configures the
  accepted IDs as `audiences: [{ uid, name }]`; clients discover that exact
  list in `q=config`'s `audiences` array and persist the `uid`, not the display
  name. Values must be configured IDs, are de-duplicated in first-seen order,
  and require `visibility: ["private"]` as the final stored value. This avoids
  recording an audience on a publicly visible post, which would misleadingly
  suggest access control exists.
- **Location Visibility** is a single-value mf2 property:
  `"location-visibility": ["public" | "private" | "text"]`. It requires at
  least one `location` property. `text` allows the serving layer to show a
  textual place name while withholding coordinates and other precise location
  data. `private` means it must withhold the entire location even when the post
  itself is public: it is a field-level redaction rule, not an audience or
  access-control claim. This intentional asymmetry lets an owner publish a
  public update without revealing where it was posted. An absent value means
  `public`, matching the upstream proposal.
- **Create/update/delete/source.** Create validates and stores these ordinary
  mf2 properties; JSON updates validate the merged result, so changing a
  private audience post to non-private (or removing its `location` while its
  disclosure preference remains) is rejected. Delete/undelete retain their
  existing whole-record behavior. `q=source` returns the stored metadata,
  including in list items and property-filtered projections.
- **Capability advertisement.** With the group enabled, `q=config` adds
  `"properties": ["audience", "location-visibility"]` and the configured
  `"audiences": [{ "uid", "name" }]`. With it disabled, neither member is
  returned and the properties remain opaque mf2 data rather than taking on
  privacy semantics.
- **Serving boundary (load-bearing).** Micropub only validates, persists, and
  advertises intent. It does **not** resolve contacts, restrict reads, redact
  coordinates, or make a private post private. The consuming site or WAC layer
  maps audience IDs to readers and applies `location-visibility` when rendering
  or serializing a post. This includes the authenticated `q=source` endpoint:
  it intentionally returns the source record unchanged.

### Proposed richer `q=source` list filters

This package-defined proposed extension is enabled only with
`extensions.proposed`. Otherwise its parameters return `400 invalid_request`
and the existing offset list is unchanged. It applies only to `q=source`
without `url`; `q=config` advertises it as `source-filters` when enabled.

All filters apply only to the authenticated caller's live posts. The serving
layer remains responsible for public visibility and access control.

| Parameter | Encoding and semantics |
| --- | --- |
| `after`, `before` | One whole-second RFC 3339 date-time each; exclusive creation-time bounds. |
| `order` | `desc` (default) or `asc`; canonical URL is the deterministic tie-breaker. |
| `post-type`, `post-status`, `visibility` | Repeatable exact values: OR within one filter and AND across filters. Missing status/visibility use `published`/`public`. |
| `property-exists[]` | Repeatable mf2 property name; each must exist. |
| `property-value[name]` | Repeatable exact direct string value. Values for a name are OR; names are AND. Nested h-* values do not match. |

Property names use only letters, digits, and hyphens after an initial letter.
Malformed dates, names, values, or ordering return `400 invalid_request`.
`properties[]` remains a response projection and never affects matching.
There may be at most 100 dynamic values across the value-bearing filters, and
at most 100 `property-exists[]` predicates; exceeding either bound is `400`
rather than a D1 host-parameter failure.

The existing `limit`/`offset` path remains for compatibility. Filtered clients
should use the opaque `next-cursor`; it is bound to the full filter set and
ordering, and is exclusive over the `(created_at, url)` tuple. `cursor` and
`offset` cannot be combined. The D1 store binds all values and indexes
`(deleted, created_at, url)` plus `(deleted, type, created_at, url)`; arbitrary
property predicates remain safe exact JSON predicates rather than full-text
search.

### Location/Venue (`q=geo`) extension

This is the implementation for issue #359. The feature is **implemented** but
**disabled by default** (`extensions.proposed: false`). Clients must enable the
`proposed` group and configure a `venues` store to use it.

Venue lookup is a proximity search over an injected venue system, never a scan
of post `location` properties; its schema, lifecycle, and indexes therefore
remain independent of Micropub's D1 post records.

The design follows the [IndieWeb Location/Venue proposal][mp-ext-geo]:
`q=geo` accepts a Geo URI or WGS-84 coordinates and returns an optional
location suggestion plus venue suggestions. The proposal's prose calls the
array `venues` while its old example says `places`; this package standardizes
on **`venues`**, the name used by the proposal issue, and emits no alias.

[mp-ext-geo]: https://indieweb.org/Micropub-extensions#Location/Venue

#### Enablement, request, and validation

The handler advertises `"geo"` in `q=config` and routes `q=geo` only when
`extensions.proposed` is `true` *and* a venue-store seam is configured. The
default remains unchanged: `q=geo` is not advertised and is an
unsupported-query `400 invalid_request`. The built-in `createMicropubVenueStore`
fails loudly at construction when its required `MICROPUB_DB` binding is
missing; it must not expose an empty, partial, or ephemeral lookup service.

Exactly one positional form is accepted:

```
?q=geo&uri=geo:37.786971,-122.399677;u=250
?q=geo&lat=37.786971&lon=-122.399677&u=250
```

`uri` is a WGS-84 [RFC 5870][rfc-5870] Geo URI with exactly latitude and
longitude; altitude and parameters other than `u` are rejected. `lat` and
`lon` are finite decimal degrees, inclusive in `[-90, 90]` and `[-180, 180]`.
The forms cannot be combined and each coordinate must occur exactly once. A
standalone `u` query parameter is allowed only with individual coordinates;
the equivalent Geo URI value is its `;u=` component. A standalone `u` alongside
`uri` is rejected, even when that URI has no `;u=` component. It is a
non-negative decimal number of metres: both the Geo URI uncertainty and the
inclusive search radius (a venue qualifies when its great-circle distance is
`<= u`). `u=0` is valid and means only exact-coordinate matches qualify; it is
not normalized to the default radius. An absent `u` means 1,000 metres; values
above 50,000 metres are rejected. This avoids a new `radius` spelling
incompatible with clients that already send `u`.

`limit` is a positive base-10 integer (default 20, maximum 100). `offset` is a
non-negative base-10 integer (default zero), and is accepted only with an
explicit valid `limit`, matching the proposed Offset extension. Duplicate or
unknown parameters, empty/non-decimal values, out-of-range coordinates/radius,
and unsupported Geo URI components return the normal Micropub `400`
`invalid_request` body. Silently broadening a location search can disclose
saved places beyond the precision a client intended.

[rfc-5870]: https://www.rfc-editor.org/rfc/rfc5870

#### Response, ordering, and pagination

The JSON response always has `venues` (possibly empty); `geo` appears only when
the venue system has a location suggestion. These are the proposal's
h-adr/h-card-shaped properties, not a complete mf2 document. **This first
implementation has no real reverse-geocoding service wired in** — `geo` always
echoes the query coordinates back as `label` rather than resolving a place
name; a future increment may replace this with an actual lookup.

```json
{
  "geo": {
    "label": "123 Main Street",
    "latitude": "37.786971",
    "longitude": "-122.399677"
  },
  "venues": [
    {
      "name": "Main Street Apothecary",
      "latitude": "37.786900",
      "longitude": "-122.399610",
      "url": "https://example.com/venues/apothecary"
    }
  ]
}
```

`geo.label`, `geo.latitude`, and `geo.longitude` are required when `geo` is
present. Every venue has an absolute `url`, non-empty `name`, and valid WGS-84
`latitude`/`longitude`; coordinates are decimal strings, as in common
microformats JSON. `visibility` is deliberately absent: it belongs to the
separate Location Visibility proposal and must not be enabled by venue lookup.

Filter to the inclusive radius before paginating, then sort by great-circle
distance ascending and canonical venue URL ascending as the deterministic
tie-breaker. `offset` skips that order and `limit` caps it. There is no count or
cursor. The backing store must apply ordering and pagination atomically so
concurrent venue changes cannot destabilize a page.

#### Venue ownership, lifecycle, and storage seam

Venues are single-owner resources for the configured `me`; they are not posts,
not rows in `MICROPUB_DB`, and never inferred from historic post locations. A
venue URL is immutable identity. Updating a venue changes metadata at that URL;
deleting it removes future `q=geo` results. Existing post source is never
rewritten or cascaded when a venue changes or is deleted.

The first `q=geo` implementation is intentionally read-only. A post selects or
references a venue by putting the returned venue `url` in its normal `location`
property (or a nested location h-card's `url`); generic mf2 source round-trips
it unchanged. Free-text locations remain valid. Venue create/update/delete stay
with the composed application's venue system: a top-level `h=card` post and an
undocumented Micropub action must not create venues. This avoids contaminating
`q=source` post listings and reserves explicit write scopes/concurrency for a
future separately designed venue-write extension.

`MicropubConfig`'s optional `venues` seam is a strongly-consistent store
matching this shape (`createMicropubVenueStore` is the built-in D1
implementation); `q=geo` stays unadvertised until both it and
`extensions.proposed` are set:

```ts
interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}
interface GeoSuggestion extends GeoPoint {
  readonly label: string;
}
interface Venue extends GeoPoint {
  readonly url: string;
  readonly name: string;
}
interface VenueStore {
  searchNearby(input: {
    readonly point: GeoPoint;
    readonly radiusMetres: number;
    readonly limit: number;
    readonly offset: number;
  }): Promise<{
    readonly geo?: GeoSuggestion;
    /** Filtered, distance-then-URL ordered, and already paginated. */
    readonly venues: readonly Venue[];
  }>;
}
```

The adapter owns durable indexes and transactions; it must not use KV for
venue data or results. A missing adapter binding must likewise fail at startup.
The handler validates store output before serialization and treats invalid
output as a server error. Implementation coverage must exercise Geo
URI/parameter validation, malformed-query HTTP errors, disabled-group
non-advertisement, store ordering/pagination, and missing store/binding startup
failures.

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
- `audiences` — optional stable `{ uid, name }` IDs for the proposed Audience
  extension. They are only advertised and validated when
  `extensions.proposed` is enabled; the consuming site/WAC layer supplies their
  actual authorization mapping.
- Media bucket binding name and any size thresholds.
- Mapping/policy for where created posts are stored.

## Conformance

- [micropub.rocks](https://micropub.rocks/) and publish an entry in the
  [implementation reports](https://micropub.net/implementation-reports/). See
  [conformance-and-testing.md](../conformance-and-testing.md).
