# @dwk/micropub

## 1.0.0-beta.2

### Patch Changes

- ec0f4a2: Background fediverse syndication via `ctx.waitUntil` instead of awaiting it
  inline in the create-post response path, so a slow or unreachable fediverse
  peer no longer delays the client's response. The MCP tool path (which has no
  `ExecutionContext`) is unaffected and still awaits syndication inline.
- ec0f4a2: Log the underlying D1 failure via the injected logger and return a generic
  `error_description` when media metadata insert fails, instead of relaying
  the raw database error message verbatim to the client.
- Updated dependencies [b1e0fc4]
- Updated dependencies [ec0f4a2]
  - @dwk/indieauth@1.0.0-beta.2

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

### Patch Changes

- Updated dependencies
  - @dwk/calendar@1.0.0-beta.1
  - @dwk/dpop@1.0.0-beta.1
  - @dwk/indieauth@1.0.0-beta.1
  - @dwk/log@1.0.0-beta.1
  - @dwk/mcp@1.0.0-beta.1

## 0.1.0-beta.5

### Patch Changes

- bf41d27: Fix a prototype-pollution vulnerability (CodeQL alert #5) across all of
  `mf2.ts`'s attacker-reachable object-key assignments, not just the
  form-encoded path: a Micropub request with a property/filter named
  `__proto__` (or `constructor`/`prototype`) reached a plain
  `obj[key] = value` assignment, which for those literal strings invokes an
  accessor instead of setting an own property.

  - `parseFormBody` (form-encoded `create`): `__proto__[x]` reached a
    double-dereference (`(nested[key] ??= {})[sub] = value`) that read and then
    wrote through the shared, global `Object.prototype` — corrupting every
    other request the Worker isolate serves afterward. This was the original,
    most severe vector.
  - `parseJsonBody` and `asPropertyMap` (used by `parseUpdateOperations` for
    JSON `create`/`replace`/`add`/`delete`): a `"__proto__"` property/JSON key
    reassigned the _result_ object's own prototype (`Object.getPrototypeOf(properties) === Array.prototype`
    was reachable), a narrower but still real type-confusion bug — JSON.parse
    itself is safe (it creates an own `"__proto__"` data property), but
    copying that key into a fresh object literal via `obj[key] = value` is not.
  - `applyUpdate` and `sourceView`: the same pattern, reachable via update
    operations and via the `?properties[]=` query-string filter on `q=source`
    respectively.

  Fix: a shared `setOwn` helper (plus explicit skip-and-continue where a key
  is also read before being written) rejects `__proto__`/`constructor`/
  `prototype` at every one of these assignment sites, alongside the existing
  form-key gate. Extended `mf2.test.ts` to cover `parseJsonBody`,
  `parseUpdateOperations`/`applyUpdate`, and `sourceView` with the same attack
  shape, asserting the affected object's own prototype/properties are
  unaffected.

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [dc59912]
- Updated dependencies [4cd36af]
  - @dwk/dpop@0.1.0-beta.4
  - @dwk/calendar@0.1.0-beta.3
  - @dwk/indieauth@0.1.0-beta.5
  - @dwk/log@0.1.0-beta.5
  - @dwk/mcp@0.1.0-beta.1

## 0.1.0-beta.4

### Minor Changes

- 48d56a4: Fediverse interop phase 3 (#276): client wiring.

  `@dwk/micropub` (#278):

  - `syndicateTo` config now also accepts an **async provider**, so target
    lists can change at runtime (e.g. followed fediverse communities);
    `q=config` / `q=syndicate-to` await it.
  - New `fediverse.ts` adapter: `entryToFediversePost` maps an `h-entry` onto
    the `POST <actor>/publish` wire shape (`photo`/`video`/`audio` → typed
    attachments with alt text, `name`+`content` → `article`, plain `content` →
    `note`, community target → titled `page` + `audience`), and `syndicateEntry`
    delivers to `@dwk/activitypub`'s publish endpoint when `mp-syndicate-to`
    names the reserved `fediverse` uid or an advertised community. Failures
    are logged per target, never fatal to the post creation. No
    `@dwk/activitypub` import — the JSON wire format is the contract.

  `@dwk/activitypub` (#278/#279):

  - `createCommunitySyndicationTargets` — an async `{uid, name}` provider of
    accepted `Group` follows (display handles like `!birding@lemmy.ml`),
    pluggable straight into micropub's `syndicateTo`; backed by a new
    internal-only `__following` DO route.
  - MCP tools (v3): `activitypub_publish` (write-scoped, `PostInput` in,
    handle-shaped audiences resolved via the SSRF-guarded WebFinger lookup)
    and the read-only `activitypub_resolve` (handle → actor IRI + type +
    profile basics), beside the existing `activitypub_list_inbox`.
  - New `discovery.ts` shared by the front door and the tools: guarded handle
    resolution and actor-document dereferencing.

- 04e16c2: Add `createMicropubMcpTools` (#240): a `@dwk/mcp` tool contribution exposing
  `micropub_publish` — publish a new mf2 post (`h-entry`, `h-event`, or any
  other type) through the same `publishPost` path (now exported from
  `handler.ts`) the HTTP `create` action uses, so both share identical
  slug-generation, collision-retry, and persistence behavior. The tool is
  side-effecting (`readOnlyHint: false`) and supports a `dryRun` argument that
  previews the URL a publish would allocate without persisting anything.
  Defaults to requiring the `create` scope, matching the HTTP endpoint.
- 8642346: Implement the proposed media-endpoint extensions (#363, roadmap #354), gated
  behind `extensions.proposed`: media `q=source` (newest-first listing and
  by-URL lookup, `media` scope required), the `{ "url": ... }` upload response
  body, and recoverable `action=delete`/`action=undelete` via an R2 `.trash/`
  prefix with scope-pair enforcement and strict URL ownership validation.
  Upload metadata is now always recorded in a new `micropub_media` D1 table
  (best-effort while the group is off, fail-closed when on); the new
  `mediaTrashRetentionDays` config (default 30) drives trash-row pruning, with
  blob purge delegated to an R2 lifecycle rule.
- 193de8d: Add opt-in proposed Audience and Location Visibility metadata, including
  configured named audiences, validation, source round-tripping, and capability
  advertisement.
- 2d594d1: Add the opt-in proposed Contacts (`q=contact`) extension with a private,
  injectable h-card store, lifecycle actions, filtering, and pagination.
- 31f95fd: Add the proposed Location/Venue (`q=geo`) extension: a read-only proximity
  search over an injected, strongly-consistent venue store, independent from
  post storage. Disabled by default — requires `extensions.proposed: true` and a
  configured `venues` store (`createMicropubVenueStore` for the built-in
  D1-backed implementation). Accepts a Geo URI or discrete `lat`/`lon`
  coordinates plus an optional `u` radius (default 1,000m, max 50,000m), and
  returns venues ordered by great-circle distance with `limit`/`offset`
  pagination. `geo`'s location suggestion is currently a placeholder that echoes
  the query coordinates back — no reverse-geocoding service is wired in yet.

  Implements the design from #359 per
  https://indieweb.org/Micropub-extensions#Location/Venue. Tracked by #354.

- 96105d1: Add opt-in proposed filters for `q=source` post lists, including creation-time,
  type, status, visibility, and exact property predicates with deterministic
  keyset cursor pagination.
- 3b55292: Add `q=source` list query extension: when no `url` parameter is provided, return
  `{ items: [...] }` containing the authenticated caller's recent posts, ordered
  newest-first by creation time. Supports offset-based pagination via `limit`
  (default 10, max 100) and `offset` (default 0) parameters. Soft-deleted posts
  are excluded. Property filtering via `properties[]` applies per-item, same as
  single-post `q=source` queries.

  Implements the widely-used Micropub post-list extension per
  https://indieweb.org/Micropub-extensions#Query_for_Post_List. Required for
  Anglesite iOS/Mac clients to browse draft posts for "resume editing" flows.

- 99a2146: Implement the first tranche of IndieWeb Micropub extensions, toggled by maturity
  group. A new `extensions` config (`{ official?, stable?, proposed? }`; defaults
  `official`+`stable` on, `proposed` off) enables extensions a group at a time.

  All new extensions are **stable**:

  - **Post Status** (`post-status`) and **Visibility** (`visibility`) — their
    values are validated on create and on the merged result of an update
    (unrecognised values are rejected `400 invalid_request`; an absent property is
    the documented default). The endpoint stores and advertises these; read-time
    enforcement (hiding drafts, gating private posts) remains the serving layer's
    responsibility.
  - **Supported Vocabulary** — an optional `postTypes` config is advertised as
    `post-types` in `q=config`.
  - **Category/Tag List** (`q=category`) — returns the distinct string `category`
    tags across live posts (soft-deleted excluded), alphabetised, for autocomplete;
    narrowable via the stable **Limit** (`limit`) and **Filter** (`filter`)
    parameters.

  Exports `validateVocabulary`, `POST_STATUS_VALUES`, `VISIBILITY_VALUES`, and the
  `ExtensionMaturity`, `ExtensionGroupsConfig`, and `PostTypeConfig` types.
  Post-list (`q=source` with no `url`) is tracked separately (#351/#353).

### Patch Changes

- 36a3be1: Bind the DPoP proof's `htu` to the configured endpoint URL instead of
  `request.url` (#300). Both resource servers verified the proof against
  `request.url`, but a client signs the **public** endpoint it POSTs to — behind
  the path-rewriting proxy the mountable-prefix composition targets, `request.url`
  is the rewritten internal URL, so every DPoP proof failed with `htu_mismatch`, a
  hard outage. `authorize` now takes the expected `htu` from the caller and each
  call site passes the relevant configured endpoint (`micropubEndpoint` /
  `mediaEndpoint` / `microsubEndpoint`), matching what `@dwk/indieauth`'s token
  endpoint already does.
- bde0341: Create D1 schema lazily so a fresh deploy no longer 500s (#291, #292). The
  IndieAuth code/token store, the Micropub post store, and the Micropub/Microsub
  DPoP replay stores previously created their tables only in an `init()` that no
  handler ever called, so a consumer composing these packages against a brand-new
  D1 hit `no such table` on the first authorization/token/publish request, and —
  because DPoP replay-checking is on by default — every authenticated
  create/update/delete `500`ed permanently.

  Each store now materialises its schema lazily on first use (the same
  `ensureSchema` pattern the webmention/websub/microsub stores already use), with
  the cached init promise cleared on failure so a transient D1 error doesn't wedge
  the store. The IndieAuth RFC 8707 `resource`-column migration now runs on that
  lazy path too, so it actually reaches consumer databases. No separate migration
  step is required.

- 36a3be1: Stop a client-controlled `Content-Type` on a served blob from becoming stored
  XSS (#299). Both packages serve public, unauthenticated blobs whose content type
  comes from the (client-controlled) upload, so an uploaded `text/html` (or
  `image/svg+xml`) would render as active content on the deployment's own origin —
  `@dwk/micropub`'s `media`-scope-only endpoint could thereby escalate to
  origin-level script execution. The serve paths now always send
  `X-Content-Type-Options: nosniff`, and only serve a known safe media type
  (image/video/audio) inline; anything else is served as an opaque
  `application/octet-stream` with `Content-Disposition: attachment`, so it
  downloads instead of executing. (Note that `nosniff` alone would not stop an
  explicit `text/html`, hence the inline allow-list.)
- bde0341: Authorize a `multipart/form-data` create before streaming its files to R2
  (#290). Previously the Micropub endpoint parsed the multipart body — including
  `env.MEDIA.put(...)` for every uploaded file — before the authorization check,
  so an unauthenticated caller could write arbitrary blobs to R2 (and orphan
  them) simply by POSTing multipart bodies, an unauthenticated storage-exhaustion
  and cost-amplification vector. The handler now parses only the text fields
  up front (memory is still capped by the existing `Content-Length` guard) and
  defers every file upload until after `authorize` succeeds. The dedicated media
  endpoint already authorized first and is unchanged.
- Updated dependencies [36a3be1]
- Updated dependencies [3e505be]
- Updated dependencies [bde0341]
- Updated dependencies [3e505be]
  - @dwk/calendar@0.1.0-beta.2
  - @dwk/indieauth@0.1.0-beta.4
  - @dwk/log@0.1.0-beta.4

## 0.1.0-beta.3

### Minor Changes

- fc4f47b: Add `hEventToCalendarEvent(mf2)` — the IndieWeb-specific adapter from a stored
  `h-event` microformats2 object to the canonical `CalendarEvent` model in the new
  [`@dwk/calendar`](https://github.com/davidwkeith/workers/tree/main/packages/calendar)
  lib, which then serializes to `.ics`/JSCalendar. It maps `uid` (falling back to
  `url`) → identity, `name` → title, `summary`/`content` → description,
  `dt-start`/`dt-end` → start/end, `location` → locations, `category` → keywords,
  and `published`/`updated` → timestamps. The adapter lives here, not in
  `@dwk/calendar`, because that cross-standard lib must stay free of IndieWeb
  assumptions. Pure and unit-tested for the `h-event → CalendarEvent → .ics`
  round-trip. Part of the calendar/events work (#170, epic #167).
- 9866e8d: Support the Micropub event post type (`h=event`). Events are created and stored
  like any other post (their `name`/`start`/`end`/`location`/`category` properties
  round-trip through `q=source`), and a new pure `renderHEvent` helper serializes a
  stored event's microformats2 to canonical `h-event` markup (`p-name`,
  `dt-start`/`dt-end`, `p-location`, `p-category`, `e-content`, `u-url`) for
  publishing. Also exports `H_EVENT` and `isEvent`. Part of the calendar/events
  work (#168).

### Patch Changes

- 6d14fc3: Fix: emit explicit `.js` extensions on relative imports so the published ESM
  packages resolve under Node's ESM loader.

  The packages were built with `moduleResolution: "Bundler"`, which let source
  files omit extensions on relative specifiers (`export { createWebmention } from
"./handler"`). `tsc` preserves specifiers verbatim, so the published
  `dist/index.js` re-exported extensionless paths that Node's ESM loader cannot
  resolve — `import("@dwk/webmention")` failed with `ERR_MODULE_NOT_FOUND` (only
  a bundler like esbuild/wrangler papered over it). Relative specifiers across the
  monorepo now carry explicit `.js` extensions, and `tsconfig.base.json` moves to
  `module`/`moduleResolution: "NodeNext"` so the compiler enforces extensions and
  this cannot silently regress.

- Updated dependencies [fc4f47b]
- Updated dependencies [6d14fc3]
  - @dwk/calendar@0.1.0-beta.1
  - @dwk/indieauth@0.1.0-beta.3
  - @dwk/dpop@0.1.0-beta.3
  - @dwk/log@0.1.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/dpop@0.1.0-beta.2
  - @dwk/indieauth@0.1.0-beta.2
  - @dwk/log@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/dpop@0.1.0-beta.1
  - @dwk/indieauth@0.1.0-beta.1
  - @dwk/log@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- 08cf029: Adopt the injectable `@dwk/log` logging and metrics seams in the remaining
  endpoint packages, so auth/authz decisions and validation rejections are no
  longer silently swallowed (see `spec/observability.md`). Each package now depends
  on `@dwk/log`, accepts an optional `logger` and `metrics` in its config
  (defaulting to no-ops), owns an exported event taxonomy, and passes the same
  `(event, fields)` to both seams. Redaction follows the cross-cutting policy:
  only machine-readable reason codes, hosts (`hostFromUrl`), HTTP method/status,
  and scopes are recorded — never tokens, codes, proofs, or bodies.
  - **`@dwk/indieauth`** (`IndieAuthLogEvent`): authorization rejections by reason
    (`client_id_invalid`, `redirect_uri_not_permitted`, `pkce_required`, …), code
    issuance, token issuance, token-endpoint rejections by reason
    (`invalid_grant`, `pkce_failed`, `dpop_invalid`, …), and revocations.
  - **`@dwk/micropub`** (`MicropubLogEvent`): authorization rejections by error
    code, validation rejections by reason (`invalid_body`, `media_too_large`,
    `missing_type`, …), action completions by verb, and media stored.
  - **`@dwk/solid-pod`** (`SolidPodLogEvent`): edge-authentication rejections by
    reason and acceptances are emitted by the stateless front door. Because a
    Durable Object cannot receive the injected seams across the isolate boundary,
    the DO signals its WAC denials, anonymous-write refusals, and DPoP replay
    rejections back to the front door via an internal `x-solid-outcome` response
    header; the front door — the composition boundary where the seams are wired —
    emits the matching events and strips the header before replying to the client.

- 65cab2c: Initial monorepo scaffold: ESM-only TypeScript packages, vitest test harness
  (Node for the pure libs, workerd via @cloudflare/vitest-pool-workers for the
  runtime-bound packages), changesets release management, and CI.
- 85bb034: Implement `@dwk/micropub`: a Micropub publishing endpoint that accepts JSON,
  form-encoded, and `multipart/form-data` requests; supports create/update/delete/
  undelete actions and the `q=config`/`q=source`/`q=syndicate-to` queries; and
  ships an R2-backed media endpoint that streams uploads and serves them back.
  Published posts are stored as microformats2 source in D1 (strongly consistent,
  never KV). Every request is authorized by a DPoP-bound IndieAuth access token —
  verified with `@dwk/indieauth`'s `verifyAccessToken`, bound via `@dwk/dpop`, and
  checked for revocation against the shared issued-token store — with the token's
  scope gating the action. The handler is mountable under any path prefix and
  fails loudly if the `MEDIA`, `MICROPUB_DB`, `AUTH_DB`, or `TOKEN_SIGNING_KEY`
  bindings are missing.
- 8cecfa5: Bind authorization to the site owner. `MicropubConfig` now requires `me` (the
  owner's IndieAuth profile URL), and `authorize` rejects any access token whose
  subject (`sub`, the canonical `me`) does not match it. Previously a token minted
  by the same issuer for _any_ `me` carrying the right scope could create, update,
  or delete posts on the site — an authorization bypass in multi-user or
  shared-issuer deployments. The `me` is canonicalized at config-resolution time
  and compared exactly against the token's already-canonical subject.

### Patch Changes

- 8cc8eb9: Close four auth/scope and conformance gaps in `@dwk/micropub` (issue #39):
  - **`create` no longer grants media uploads.** The media endpoint now
    authorizes with the dedicated `media` scope only, not `["media", "create"]`.
    A `create`-only token authorizes creating posts (including photos folded into
    a multipart create) but not arbitrary blob uploads to the media endpoint —
    least privilege, matching the distinct `media` scope advertised by `q=config`.
  - **DPoP proof `jti` replay is now enforced.** `@dwk/dpop` proves a proof is
    fresh but, per RFC 9449, delegates replay detection to the caller. `authorize`
    now records each accepted `jti` in a new strongly-consistent, short-TTL D1
    table (`dpop_proofs` in `MICROPUB_DB`) and rejects a duplicate, so a captured
    proof can no longer be replayed within its acceptance window to repeat a
    state-changing request. The TTL spans `2 × DEFAULT_MAX_AGE_SECONDS` to cover
    the full window a proof stays cryptographically acceptable. Gated by the new
    `checkDpopReplay` config (default `true`).
  - **Registered Micropub/OAuth error codes.** Error bodies that used the
    non-standard `not_found`/`conflict` codes now use `invalid_request` while
    keeping their `404`/`409` HTTP status, so conformance clients keying on
    `error` recognize them.
  - **Update operands are stripped of `mp-*` commands.** `applyUpdate` previously
    applied `replace`/`add`/`delete` operands directly, letting a client persist
    `mp-slug`/`mp-syndicate-to` into stored properties (surfacing via `q=source`)
    where create rejects them. Update operands now run through the same `mp-*`
    command filtering as create, while real mf2 properties (`url`, `name`, …) pass
    through unchanged.

- 44e82b5: Reject a request that transmits the access token in both the `Authorization`
  header and the request body with `invalid_request` (HTTP 400), as required by
  RFC 6750 §2 ("clients MUST NOT use more than one method to transmit the token").
  Header-only and body-only token transmission are unchanged.
- ac90fce: Tidy package metadata for cross-package consistency.
  - **`@dwk/microsub`:** exclude `src/test-harness.ts` from the published `files`
    array so the Miniflare test harness no longer ships in the tarball, matching
    every other Durable-Object/`workerd` package.
  - **`keywords`:** backfill an npm `keywords` array on the packages that lacked
    one, so all published packages carry discovery keywords in the same style.
  - **`index.ts` doc comments:** normalize the spec pointer to the
    `@see spec/packages/<name>.md` tag (instead of prose or a missing pointer) on
    the libs whose headers had drifted, per the repo convention.

- 05ee6b2: Stop buffering the full body on the blob **write** path, honouring the
  "stream R2 bodies through the Worker — never buffer a blob in the DO" mandate
  (#31). Previously three write paths materialised the entire body in memory —
  exactly for the oversized bodies routed to R2 because they exceed the ~2 MB cell
  ceiling (up to the 128 MB limit).
  - `@dwk/store`: `putBlob` now accepts a `ReadableStream`/`Blob` and hashes it
    with a `DigestStream` while streaming it to a staging key, then promotes the
    staged object to its content-addressed key (skipped when an identical body
    already exists, so writes still dedupe) — the DO never holds the whole body.
    In-memory `ArrayBuffer`/`Uint8Array` inputs keep the direct write path.
  - `@dwk/solid-pod`: `#writeBody` routes on the declared `Content-Length` — a
    body known to fit the cell is read into memory (bounded) and, if RDF, parsed
    into quads; anything larger is streamed straight to R2. An undeclared length
    is probed only up to the ceiling; a body that overflows the probe is rejected
    with `411 Length Required` rather than buffered whole. The front door forwards
    `Content-Length` to the DO for this routing.
  - `@dwk/micropub`: the media endpoint and multipart create now reject an upload
    whose `Content-Length` exceeds `maxMediaBytes` (with `413`) _before_
    `formData()` reads the body into memory.

- Updated dependencies [cdda653]
- Updated dependencies [171749e]
- Updated dependencies [28a1693]
- Updated dependencies [08cf029]
- Updated dependencies [589db69]
- Updated dependencies [818c101]
- Updated dependencies [6f446cd]
- Updated dependencies [2ef7e3c]
- Updated dependencies [44e82b5]
- Updated dependencies [65cab2c]
- Updated dependencies [78f1a6f]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
  - @dwk/dpop@0.1.0-beta.0
  - @dwk/indieauth@0.1.0-beta.0
  - @dwk/log@0.1.0-beta.0
