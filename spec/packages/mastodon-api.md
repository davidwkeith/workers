# `@dwk/mastodon-api`

| | |
|---|---|
| **Type** | endpoint (client API) |
| **Ships a DO?** | no (reads `@dwk/activitypub`'s DO through the `MastodonBackend` seam) |
| **Used by** | `@dwk/activitypub` (the phase-2 `createActivitypubMastodonApi` adapter) |
| **Standard** | [Mastodon client API](https://docs.joinmastodon.org/client/intro/) (de-facto) |
| **Status** | phase 1 implemented (auth + identity); phases 2–3 tracked in [#349](https://github.com/davidwkeith/workers/issues/349) / [#350](https://github.com/davidwkeith/workers/issues/350) |

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

## Phase 2/3 (not yet implemented)

Tracked in [#349](https://github.com/davidwkeith/workers/issues/349) and
[#350](https://github.com/davidwkeith/workers/issues/350), specified in the
[design doc](../mastodon-client-api.md): the `__client/*` DO routes and
extended `__stats` in `@dwk/activitypub`, `createActivitypubMastodonApi`,
timelines/notifications/statuses with snowflake IDs and `Link` pagination,
`accounts/:id`, the AS2 → entity mapping with read-time sanitization and
FEP-1b12 reblog provenance, actor-profile hydration, and the
`conformance/mastodon-client-qa.md` real-client runbook (Pixelfed app,
Tusky) with `conformance/status.json` gating.
