# `@dwk/mastodon-api`

| | |
|---|---|
| **Type** | endpoint (client API) |
| **Ships a DO?** | no (reads `@dwk/activitypub`'s DO through the `MastodonBackend` seam) |
| **Used by** | `@dwk/activitypub` (the `createActivitypubMastodonApi` adapter) |
| **Standard** | [Mastodon client API](https://docs.joinmastodon.org/client/intro/) (de-facto) |
| **Status** | phases 1–3 implemented (phase 3 manual client QA pending, [#350](https://github.com/davidwkeith/workers/issues/350)) |

A Mastodon-compatible client API subset so a site owner can **log in with an
off-the-shelf fediverse client** (Pixelfed's app, Tusky, Elk) and browse their
own account — read-only. The authoritative design, including all resolved
open questions, is [`spec/mastodon-client-api.md`](../mastodon-client-api.md)
([#327](https://github.com/davidwkeith/workers/issues/327)); this per-package
spec records the implemented surface.

## Composition

- `createMastodonApi(config)` — composition-contract handler
  `(request, env, ctx) => Promise<Response>` over the `Env` fragment
  `{ AUTH_DB: D1Database }` (the shared auth-database binding name;
  `mastodon_`-prefixed tables). Fails loudly when the binding is missing.
- Config is factory-injected: `baseUrl`, `instance` metadata, the owner
  `account`, the `approveAuthorization` hook, optional `softwareVersion`,
  code lifetime, page-size bounds, and the optional `backend`.
- **`MastodonBackend` seam** (defined here, implemented by
  `@dwk/activitypub` in phase 2): `account()` (profile + live counts),
  `timeline(query)`, `notifications(query)`, `entry(id)` — plain-data,
  promise-returning, no Durable Object knowledge in this package.
- The whole surface is CORS-open (`*`, with preflight) for web clients.

## Endpoint roster (phase 1)

| Endpoint | Auth | Backing |
| --- | --- | --- |
| `POST /api/v1/apps` | none (open registration) | D1 `mastodon_apps` |
| `GET /api/v1/apps/verify_credentials` | any live token | D1 |
| `GET /oauth/authorize` | approval hook | D1 `mastodon_codes` |
| `POST /oauth/token` | client secret (post or Basic) | D1 `mastodon_tokens` |
| `POST /oauth/revoke` | client secret | `@dwk/oauth` RFC 7009 handler |
| `GET /api/v1/instance`, `GET /api/v2/instance` | none | config |
| `GET /api/v1/accounts/verify_credentials` | account token | config + backend counts (zeros without a backend) |
| `GET`/`POST /api/v1/markers` | account token | D1 `mastodon_markers` |
| stub roster (below) | per-route | static bodies |

**Stubs** (`200`, empty-but-valid, data-driven roster): `/api/v1/filters`,
`/api/v2/filters`, `/api/v1/lists`, `/api/v1/custom_emojis` (public),
`/api/v1/announcements`, `/api/v1/follow_requests`, `/api/v1/conversations`,
`/api/v1/favourites`, `/api/v1/bookmarks`, `/api/v1/preferences` (defaults
object). Everything else under `/api/` (including `/api/v1/push/subscription`
— Web Push is a non-goal) answers `404` with Mastodon's error shape
`{"error": "Record not found"}`.

## Auth model

- **Registration** (`POST /api/v1/apps`): Mastodon's pre-RFC-7591 wire shape
  (JSON or form; `redirect_uris` as array or newline-separated string) mapped
  onto `@dwk/oauth`'s `validateClientMetadata`. Custom-scheme redirect URIs
  (RFC 8252) and `urn:ietf:wg:oauth:2.0:oob` are accepted; no `https:`-only
  policy. Client secrets are stored SHA-256-hashed (the `ClientRecord.
  clientSecret` field holds the hash); the plaintext appears exactly once, in
  the registration response. Never-authorized registrations are swept after
  30 days, opportunistically on the registration write path.
- **Authorize** (`GET /oauth/authorize`): exact-match redirect URI against
  the registration; client/redirect failures are `400`s, never redirects
  (RFC 6749 §4.1.2.1). Owner authentication + consent is the config-injected
  `approveAuthorization` hook (the IndieAuth pattern — return a `Response`
  to render, or `{approved: true}` to mint). Codes are 10-minute, single-use
  (conditional `UPDATE … RETURNING`), bound to client + redirect URI + scope
  + optional PKCE S256 challenge (`plain` is rejected). `oob` renders the
  code in the page `<title>` and body.
- **Token** (`POST /oauth/token`): `authorization_code` (client secret via
  form post or HTTP Basic; PKCE verified when a challenge was recorded) and
  `client_credentials` (account-less token — only
  `apps/verify_credentials` and public endpoints accept it; account
  endpoints answer `422`). Response:
  `{access_token, token_type: "Bearer", scope, created_at}`.
- **Tokens** are opaque 256-bit random strings stored as SHA-256 hashes with
  `scope`, `client_id`, `account_id`, `created_at`, `revoked` — the repo's
  documented, mitigated **exception to DPoP-everywhere**
  ([non-functional-requirements.md](../non-functional-requirements.md)):
  read-only surface, isolated audience (no other package accepts them),
  hashed at rest, RFC 7009 revocable. Scopes are recorded as requested and
  **echoed as granted, never narrowed**; enforcement is that no write
  endpoint exists.

## Entity fields emitted (phase 1)

- **`Application`**: `id` (decimal string of `client_id_issued_at`), `name`,
  `website`, `redirect_uri` (newline-joined legacy string), `redirect_uris`,
  `scopes`; plus `client_id`/`client_secret` only in the registration
  response. **No `vapid_key`.**
- **`CredentialAccount`**: `id` (constant `"1"` — single owner), `username`,
  `acct` (local), `display_name`, `locked:false`, `bot:false`,
  `discoverable:true`, `group:false`, `created_at`, `note`, `url`,
  `avatar`/`avatar_static`/`header`/`header_static` (transparent-pixel data
  URI fallback), `followers_count`/`following_count`/`statuses_count`
  (backend counts or zeros), `last_status_at:null`, `emojis:[]`,
  `fields:[]`, `source{privacy,sensitive,language,note,fields,
  follow_requests_count}`.
- **`Instance` v1**: `uri`, `title`, `short_description`, `description`,
  `email`, `version` (`"4.2.0 (compatible; dwk-workers/<v>)"`), `urls: {}`
  (**no streaming URL**), `stats`, `thumbnail`, `languages`,
  `registrations:false`, `approval_required:true`, `invites_enabled:false`,
  `contact_account:null`.
- **`Instance` v2**: `domain`, `title`, `version`, `source_url`,
  `description`, `usage.users.active_month`, `thumbnail.url`, `languages`,
  `configuration{accounts,statuses,media_attachments,polls}`,
  `registrations{enabled:false,approval_required,message}`,
  `contact{email,account}`, `rules:[]`.
- **`Marker`**: `last_read_id`, `version` (incremented per save),
  `updated_at` (ISO 8601).

## Storage (D1, shared `AUTH_DB`)

`mastodon_apps` (`ClientRecord` rows: metadata JSON + secret hash),
`mastodon_codes` (single-use via conditional UPDATE, expiry-indexed,
opportunistically pruned), `mastodon_tokens` (hash-keyed), and
`mastodon_markers` (≤2 rows). Strongly consistent reads on every request —
**never KV**. No `requires` edge onto `indieauth`; the binding name is shared
so composers deduplicate onto one auth database.

## Endpoint roster (phase 2)

Implemented in [#349](https://github.com/davidwkeith/workers/issues/349),
the DO-backed read surface. Every route below requires an account-bound
token (`422` for an app-level `client_credentials` token, same as phase
1's account endpoints; the `accounts/:id*` rows accept any valid bearer)
and, absent a configured `backend`, degrades to an
empty-but-valid response (`[]` for the list endpoints, `404` for the
two entry endpoints) rather than erroring.

| Endpoint | Auth | Backing |
| --- | --- | --- |
| `GET /api/v1/timelines/home` | account token | `MastodonBackend.timeline()` |
| `GET /api/v1/notifications` | account token | `MastodonBackend.notifications()` |
| `GET /api/v1/statuses/:id` | account token | `MastodonBackend.entry(id)` |
| `GET /api/v1/accounts/:id` | account token | owner (config) or reversibly-decoded remote id — no backend call |
| `GET /api/v1/accounts/:id/statuses` | bearer | owner id → `MastodonBackend.ownStatuses()` (own outbox posts); remote ids → `[]` (no remote status history is stored); undecodable ids → `404` |
| `GET /api/v1/accounts/:id/{followers,following,featured_tags}` | bearer | valid-but-empty `[]` (follower/following IRIs are not exposed through the client API) |
| `GET /api/v1/accounts/relationships` | bearer | valid-but-empty `[]`, registered as an **exact** stub route so the id is never misread by the dynamic `accounts/:id` pattern |

The `accounts/:id*` additions come from the 2026-07-23 Ice Cubes client-QA
run (`conformance/mastodon-client-qa.md`): the profile view hard-errors on
a `404` from `accounts/:id/statuses`, and `accounts/relationships` was
being swallowed by the dynamic route. Like `accounts/:id`, they require a
valid bearer but accept an app-level token.

List endpoints (`timelines/home`, `notifications`,
`accounts/:id/statuses`) accept `limit`, `max_id`, `since_id`, `min_id`
(opaque decimal snowflake strings) and
answer an RFC 8288 `Link: rel="next"/"prev"` header built from the
returned page's first/last ids, Mastodon's own pagination convention.

## The `MastodonBackend` seam, in practice

`@dwk/activitypub`'s `createActivitypubMastodonApi`
(`packages/activitypub/src/mastodon-api.ts`) is the only implementation:
it builds a synthetic internal `Request` to the owning actor's Durable
Object (`__stats`, `__client/timeline` — with `source=1` for the optional
`ownStatuses()` method, which skips the inbox scan and pages only owner
outbox posts — `__client/notifications`,
`__client/entry`, carrying `INTERNAL_HEADERS.config` +
`INTERNAL_HEADERS.internal`) rather than holding an in-DO closure —
the `mcp-tools.ts`/`syndication.ts` internal-fetch pattern, not
`createSolidPodWebdav`'s. `@dwk/mastodon-api` itself never computes a
DO row's `received_at`/`seq`; it only ever handles the opaque decimal
snowflake strings the seam's `maxId`/`sinceId`/`minId`/`id` params
already specify.

## Snowflake ID scheme

Mastodon-shaped, decimal-string ids for phase-2 inbox-derived entries:
`(receivedAtMs << 16) | (source << 15) | (seq & 0x7FFF)`. `source` is
reserved and always `0` in v1 (inbox rows only); phase 3 reserves `1` for
outbox-derived rows without changing already-minted ids.

This encoding is **lossy on `seq`**: only its low 15 bits survive, so a
naive decode-and-compare against the DO's `inbox.seq` column silently
targets the wrong row once a table exceeds 32768 entries. The resolution
(`@dwk/activitypub`'s adapter, not this package) is to bound and locate
rows by `received_at` — preserved exactly by the encoding, only ever
shifted, never masked — with the decoded `seq` low bits used solely as a
same-millisecond tiebreak, never as a bare recovered bound. See
`docs/superpowers/specs/2026-07-21-mastodon-phase2-implementation-notes.md`
for the full cursor contract (`max_received_at`/`since_received_at`/
`min_received_at` + `tie_seq` on the internal DO routes).

## Entity fields emitted (phase 2)

- **`Status`** (from a `Create`/`Announce` inbox row): `id` (snowflake),
  `created_at`, `in_reply_to_id: null`, `in_reply_to_account_id: null`
  (reply-threading to a local snowflake is a known v1 gap — see below),
  `sensitive`, `spoiler_text`, `visibility: "public"`, `language: null`,
  `uri`/`url` (the embedded object's `id`, falling back to the entry id),
  `replies_count`/`reblogs_count`/`favourites_count: 0`, `content`
  (sanitized HTML — see below), `reblog` (non-null only for a
  `relayed_by` row — FEP-1b12 group-relay provenance, wrapped as a boost
  attributed to the relaying group's account), `account` (best-effort
  remote `Account`, see below), `media_attachments`, `mentions: []`,
  `tags: []`, `emojis: []`, `card: null`, `poll: null`.
- **`Notification`**: `Like` → `favourite`, `Announce` → `reblog`, a
  `Create` whose `inReplyTo` targets this instance → `mention` (with the
  full mapped `Status` attached); `Follow` (or its FEP-1b12 `Group`
  membership synonym `Join`) → `follow` — `@dwk/activitypub`'s `#onFollow`
  stores the activity in `inbox` for each *new* follower, so a re-Follow
  from an existing follower is not a fresh notification; any other row maps
  to `null` and is omitted from the page.
- **Remote `Account`** (embedded in `Status.account` /
  `Notification.account`): synthesized purely from the actor IRI, no
  backend call and no outbound fetch (`spec/mastodon-client-api.md`:
  "no enumeration"). `id` is `r_<base64url(actorIri)>` — reversible, so
  `GET /api/v1/accounts/:id` can resolve it back to the IRI and re-derive
  the same best-effort entity with zero backend calls. `username`/`acct`
  come from the IRI's last path segment and host; every count is `0`,
  `discoverable: false`; actor-document hydration (real display name,
  avatar, bio) is phase 3's actor-profile hydration cache.

## Read-time HTML sanitization

Inbound status `content` is attacker-controlled remote-server AS2 JSON, so
`sanitize.ts`'s `sanitizeStatusHtml` runs a small allowlist sanitizer
(`p`, `br`, `a`, `span`, `b`, `strong`, `i`, `em`, `ul`, `ol`, `li`; a
short per-tag attribute allowlist; `href`/`src` reject non-http(s)
schemes) before any content reaches a client. It is **fail-safe by
construction**: every `<` the scanner finds is either fully consumed as
part of a tag matching the recognized grammar, or HTML-escaped — there is
no third path where an unrecognized or malformed tag-shaped span is
passed through as live markup. Unusual markup degrading to escaped plain
text is correct behavior, not a bug.

## Known gaps (phase 2)

- **Bare-IRI `Announce` / `in_reply_to_id` resolution is local-only.** Both
  reply-threading and bare-IRI boost hydration are resolved at read time
  against posts the actor DO already holds (its owner outbox, then its
  inbox) via `#resolveLocalObject` — pure SQL, never an outbound fetch. A
  reply to a locally-held post carries that post's snowflake
  (`in_reply_to_id`) and its author (`in_reply_to_account_id`); a bare-IRI
  boost of a locally-held post renders its reblog with the real content and
  author. A target the DO does **not** hold still degrades to `null`
  (reply) or a content-less reblog (boost) — dereferencing and caching a
  remote boosted/replied-to object is the remaining increment, the same
  network-fetch shape as actor-profile hydration.

## Phase 3 (implemented; manual QA pending)

Tracked in [#350](https://github.com/davidwkeith/workers/issues/350),
implements actor-profile hydration (real display name/avatar/bio for remote
accounts, refreshed by the actor DO's alarm and never in a client request),
merges the owner's own `outbox` posts into the home timeline (additive, via
the snowflake's reserved source bit), and derives reply/favourite/reblog
counters from stored inbox activity. The Pixelfed and Tusky runs remain the
acceptance gate in `conformance/mastodon-client-qa.md`; record/fix client
quirks there before marking the conformance suite passing.

Reply-threading and bare-IRI boost hydration are implemented for
locally-held targets (see Known gaps above); only the remote-dereference
case remains. Follow notifications are implemented — `@dwk/activitypub`
stores each new follower's `Follow`/`Join` in the inbox and the
notifications read maps it to `type: "follow"`.
