# @dwk/micropub

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
