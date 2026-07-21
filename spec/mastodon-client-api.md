# Mastodon-compatible client API (`@dwk/mastodon-api`)

**Status: design — proposed, not yet implemented.** Tracked in
[#327](https://github.com/davidwkeith/workers/issues/327). This document
extends [`spec/packages/activitypub.md`](packages/activitypub.md) and
coexists with [`spec/fediverse-interop.md`](fediverse-interop.md); both stay
authoritative for everything they already cover. At implementation time this
doc seeds a `spec/packages/mastodon-api.md` per-package spec.

## Motivation

Surfaced during the Pixelfed manual conformance run
([`conformance/pixelfed-qa.md`](../conformance/pixelfed-qa.md), step 4): after
a real Pixelfed account liked and replied to a post, there was **no way to
confirm those activities landed** — the S2S `/inbox` route is write-only by
design, and the only read path is `@dwk/mcp`'s agent-facing
`activitypub_list_inbox` (not mounted on the conformance target). More
broadly: a site owner today cannot **log in with the Pixelfed, Tusky, or any
Mastodon-API-compatible client app and see their own feed and notifications**
— the ordinary experience of running a fediverse account.

The goal is deliberately small: **read-only browsing through off-the-shelf
clients**. App login, notifications, home timeline. Publishing stays with
micropub/MCP/the publish endpoint; this surface adds no second write path.

### Relationship to the fediverse-interop non-goal

`spec/fediverse-interop.md` lists *platform client APIs* as a non-goal, and
that remains true **for `@dwk/activitypub`**: the federation package never
grows Mastodon REST vocabulary, and federation behavior is unchanged by this
design. What changes is the composition: a *separate, optional* package
serves the client API by reading the same per-actor Durable Object through
the internal seam `@dwk/activitypub` already exposes to its MCP tools. The
non-goal was about keeping platform API maintenance out of the federation
core — confinement — not about forbidding the capability from the composed
Worker.

## Decision 1 — packaging: a new endpoint package plus an adapter in `@dwk/activitypub`

Issue #327's first open question (inside `@dwk/activitypub` vs a separate
package) is resolved by the two precedents this repo already has:

- `@dwk/webdav` ships the pure WebDAV protocol core over an injected
  `WebdavBackend` seam; `@dwk/solid-pod` — the DO owner — exports
  `createSolidPodWebdav`, the composed adapter.
- `@dwk/mcp` ships the protocol core and `ToolDefinition` types;
  `@dwk/activitypub` — the DO owner — exports `createActivitypubMcpTools`.

The same shape applies here:

- **`@dwk/mastodon-api`** (new endpoint package, named for the de-facto
  standard it implements — the
  [Mastodon client API](https://docs.joinmastodon.org/client/intro/)):
  - the Mastodon **entity model and serializers** (`Account`, `Status`,
    `Notification`, `Instance`, `MediaAttachment`, …) as pure functions from
    plain-data inputs;
  - the **route/verb router** `createMastodonApi(config)` for `/api/v1/*`,
    `/api/v2/instance`, and `/oauth/*`, driven over an injected
    **`MastodonBackend`** seam (profile + counts, timeline page,
    notifications page) — no Durable Object knowledge;
  - the **app OAuth flow** (`/api/v1/apps`, authorize, token, revoke) over
    `@dwk/oauth` primitives, with its own D1-backed app/token/code store
    (Cloudflare specifics are allowed in endpoint packages);
  - the AS2 → Mastodon-entity **mapping** (plain JSON in, entities out) and
    the read-time HTML sanitizer.
- **`@dwk/activitypub`** gains one export, `createActivitypubMastodonApi`
  (mirroring `createSolidPodWebdav`): it instantiates `createMastodonApi`
  with an in-package backend adapter that reaches the `ActivityPubObject` DO
  through the existing internal seam (`forwardedConfig` + the
  internal-header-gated `__`-routes — the exact mechanism
  `createActivitypubMcpTools` and `createCommunitySyndicationTargets` use).
  Dependency direction is `@dwk/activitypub → @dwk/mastodon-api`
  (`workspace:*`), same as `@dwk/solid-pod → @dwk/webdav`. Tree-shaking keeps
  the client API out of composed Workers that don't mount it.

Why not a `client-api.ts` module inside `@dwk/activitypub`:

- **Confinement.** Mastodon REST response shapes, snowflake IDs, and OAuth
  app plumbing have nothing to do with federation; keeping them out of the
  federation package is the composition contract's spirit applied here.
- **Bindings.** The client API needs a D1 database for apps/tokens/codes.
  Folding it in would put that binding (and the `@dwk/oauth` dependency) on
  every `@dwk/activitypub` deployment's `Env` fragment, mounted or not.
- **Composability.** A separate catalog worker means the owner toggles
  "Fediverse client login" independently of "be a fediverse actor", and the
  package versions/conformance-gates independently.

Why not fully standalone (no `@dwk/activitypub` involvement): the data lives
in the actor DO, and only `@dwk/activitypub` may know its internal routes and
header contract. The backend seam keeps that knowledge where it belongs while
the protocol core stays testable without it.

### The `MastodonBackend` seam

Plain-data, promise-returning, defined in `@dwk/mastodon-api`:

```ts
interface MastodonBackend {
  /** Actor profile + live counts (followers/following/statuses). */
  account(): Promise<BackendAccount>;
  /** Newest-first page of timeline entries (Create/Announce rows). */
  timeline(query: BackendPageQuery): Promise<BackendPage<BackendEntry>>;
  /** Newest-first page of notification entries (Follow/Like/Announce/mention rows). */
  notifications(query: BackendPageQuery): Promise<BackendPage<BackendEntry>>;
  /** Single stored entry by snowflake id (statuses/:id, notification targets). */
  entry(id: string): Promise<BackendEntry | null>;
}

interface BackendPageQuery {
  readonly limit: number; // clamped by the backend
  readonly maxId?: string; // exclusive upper bound (snowflake)
  readonly sinceId?: string; // exclusive lower bound
  readonly minId?: string; // exclusive lower bound, oldest-first window
}

interface BackendEntry {
  readonly id: string; // snowflake, see Decision 3
  readonly activity: Record<string, unknown>; // stored AS2 JSON, verbatim
  readonly receivedAt: number; // epoch ms
  readonly objectType: string | null; // classification column
  readonly relayedBy: string | null; // FEP-1b12 provenance column
}
```

The entries carry the stored AS2 JSON verbatim; all Mastodon-shaping happens
in the pure mapping layer so it unit-tests under Node against fixture JSON
captured from real Mastodon/Pixelfed/Lemmy traffic.

### New internal DO routes (additive, in `@dwk/activitypub`)

The existing `__inbox` route is page/offset-paginated and unfiltered — fine
for the MCP tool, wrong for client pagination. The backend adapter needs, all
internal-header-gated like the existing `__stats`/`__inbox`/`__following`:

- `GET <actor>/__client/timeline` and `GET <actor>/__client/notifications` —
  `seq`-keyed cursor pagination (`max_seq`/`since_seq`/`min_seq` + `limit`)
  over the `inbox` table, filtered in SQL by the existing `object_type`
  column plus a read-time JSON classification for the notification split
  (see Decision 3). Rows with `verify_state = 'failed'` never appear
  (they are deleted anyway per fediverse-interop §2.2).
- `__stats` extended additively with `followers`/`following`/`statuses`
  counts (it already computes users/localPosts from the same tables;
  `#count` exists for all three collections).

No schema change is required for v1. A `notification_type` column (populated
by `classifyActivity` alongside `object_type`) is a natural optimization if
read-time JSON filtering shows up in practice; it is additive and deferred.

## Decision 2 — auth: Mastodon-shaped OAuth over `@dwk/oauth`, opaque bearer tokens

Issue #327's second open question (reuse `@dwk/indieauth`/`@dwk/oauth` vs a
thin adapter) resolves to: **`@dwk/mastodon-api` becomes the first real
consumer of `@dwk/oauth`**, and does *not* reuse `@dwk/indieauth`'s handler
or token format. Rationale:

- `@dwk/indieauth`'s grant is profile-URL identity with PKCE required, public
  clients only (`token_endpoint_auth_methods_supported: ["none"]`), and its
  tokens are DPoP-bound JWTs whose downstream verifiers (`micropub`, the pod)
  hard-require `cnf.jkt` and a DPoP proof. Off-the-shelf Mastodon apps send
  `client_secret` in the token request and a plain `Authorization: Bearer`
  header — they cannot satisfy any of that, and bending IndieAuth's contract
  to admit unbound tokens would weaken every existing consumer.
- `@dwk/oauth` already ships exactly the pieces the Mastodon flow needs as
  plain-data building blocks: `validateClientMetadata`/`ClientRecord`
  issuance (RFC 7591), `createRevocationHandler` (RFC 7009), the shared
  OAuth error registry, and the metadata builder. It deliberately does *not*
  ship an authorize/token grant handler — the grant is this package's to
  own.

### Endpoints

- **`POST /api/v1/apps`** — Mastodon's pre-RFC-7591 dynamic registration.
  A thin wire adapter (form-encoded or JSON `client_name` / `redirect_uris` /
  `scopes` / `website` in; Mastodon `Application` entity with `client_id` +
  `client_secret` out) around `@dwk/oauth`'s metadata validation and
  credential minting. Registration is unauthenticated and rate-limit-free in
  Mastodon; records are inert until the owner approves an authorization, so
  the only cost of an unwanted registration is a D1 row (bounded by a
  periodic sweep of never-authorized apps).
  `GET /api/v1/apps/verify_credentials` validates a client-credentials token
  (see below).
- **`GET /oauth/authorize`** — validates `client_id`, exact-match
  `redirect_uri`, `response_type=code`, requested scopes; then delegates
  owner authentication + consent to a **config-injected approval hook**,
  the same pattern as `@dwk/indieauth`'s `approveAuthorization` (the
  conformance target's `approval.ts` consent form is the worked example).
  The package ships no login UI and stores no owner password. On approval it
  mints a single-use, 10-minute authorization code bound to
  client + redirect URI + scope (+ PKCE S256 challenge when the client sent
  one — supported, not required, matching Mastodon ≥4.3), and redirects with
  `code` + `state`. `urn:ietf:wg:oauth:2.0:oob` renders the code instead.
  Native-app custom-scheme redirect URIs are allowed per RFC 8252 (Tusky,
  the Pixelfed app, and most mobile clients use them); the registration
  `redirectUriPolicy` must not force `https:`.
- **`POST /oauth/token`** — `authorization_code` grant: authenticate the
  client (`client_id` + `client_secret`, form body per Mastodon practice),
  redeem the code single-use (conditional-UPDATE, the IndieAuth store
  pattern), verify PKCE when a challenge was recorded, mint the access
  token. Response `{access_token, token_type: "Bearer", scope, created_at}`.
  The `client_credentials` grant is a SHOULD (some clients, including the
  official Mastodon app, fetch an app-level token before login; it grants no
  account access — only `/api/v1/apps/verify_credentials` and public
  instance endpoints accept it).
- **`POST /oauth/revoke`** — `@dwk/oauth`'s `createRevocationHandler` with
  client authentication; always `200` per RFC 7009 and Mastodon behavior.

### Token model — and the DPoP exception

Access tokens are **opaque 256-bit random strings**, stored as SHA-256
hashes in D1 with `scope`, `client_id`, `created_at`, `revoked`. Every
`/api/v1/*` request hashes the presented bearer and looks it up — a
strongly-consistent read per the consistency rules (D1 with session
consistency; never KV). No JWT: Mastodon tokens are long-lived with no
refresh flow, so revocation-by-lookup *is* the lifecycle, and an opaque
token avoids stretching `@dwk/indieauth`'s `cnf.jkt`-required claim shape.

This is a deliberate, scoped exception to the repo's "DPoP everywhere
tokens are used" rule ([non-functional-requirements.md](non-functional-requirements.md)),
because the entire point is compatibility with clients that only speak
plain bearer. Mitigations, all load-bearing:

- **Read-only surface.** v1 tokens authorize reads only; there is no write
  endpoint behind them (see non-goals), so a stolen token cannot post,
  follow, or delete.
- **Separate audience.** These tokens live in their own store and are
  accepted *only* by `createMastodonApi`'s routes. `micropub`, the pod, MCP,
  and every DPoP-bound surface reject them structurally (different store,
  different format) — a Mastodon token can never escalate onto a
  DPoP-protected surface, and vice versa.
- **Full lifecycle.** RFC 7009 revocation, plus the owner-side list/revoke
  management the approval hook naturally anchors (same spirit as the
  WebDAV app-password endpoint).

### Scopes

Mastodon scope strings (`read`, `write`, `follow`, `push`, and the granular
`read:*` forms) are recorded as requested and **echoed as granted** — real
clients register with `read write follow push` by default and several treat
a narrower grant as an error, so silently narrowing breaks login. Enforcement
happens at the endpoint layer instead: v1 mounts only read endpoints, so a
`write`-scoped token still cannot do anything write-shaped (the unmounted
endpoints 404 with a Mastodon-style error body). The approval hook shows the
requested scopes to the owner at consent time.

### Storage

Four tables in D1 — `mastodon_apps`, `mastodon_codes`, `mastodon_tokens`,
and `mastodon_markers` (saved read positions per timeline — per-account
state, and this deployment has one account, so two rows; kept in D1 rather
than the DO because it is client-session state, not federation state) —
behind a store interface defined in `@dwk/mastodon-api` (adding the
`getClient(clientId)` read that `@dwk/oauth`'s `saveClient`-only seam
deliberately leaves to consumers). The catalog entry declares the binding as
**`AUTH_DB`**, the same shared-binding name `indieauth`/`micropub`/`microsub`
use (shared bindings share names; the composer deduplicates) — one auth
database per site, table-namespaced per package, with **no** `requires`
edge onto `indieauth`.

## Decision 3 — entity fidelity: what real clients need to not error

Issue #327's third open question. The roster below is grounded in the
implement-the-client-API precedents (GoToSocial, Friendica, the
Enable-Mastodon-Apps WordPress plugin) rather than the API reference alone;
the binding acceptance test is real clients (see Conformance).

### Endpoint roster

**Functional (v1):**

| Endpoint | Backing |
| --- | --- |
| `GET /api/v1/instance`, `GET /api/v2/instance` | config + extended `__stats` counts |
| `POST /api/v1/apps`, `GET /api/v1/apps/verify_credentials` | D1 app store |
| `GET /oauth/authorize`, `POST /oauth/token`, `POST /oauth/revoke` | D1 codes/tokens + approval hook |
| `GET /api/v1/accounts/verify_credentials` | `ActorProfile` config + `__stats` counts |
| `GET /api/v1/accounts/:id` | own actor from config; remote actors synthesized from stored activity JSON |
| `GET /api/v1/timelines/home` | `__client/timeline` |
| `GET`/`POST /api/v1/markers` | D1 `mastodon_markers` (two rows: `home` + `notifications` read positions) |
| `GET /api/v1/notifications` | `__client/notifications` |
| `GET /api/v1/statuses/:id` | `entry(id)` |

Both instance documents ship v1 (clients still call v1 first; the WordPress
precedent found v1 alone sufficient, but v2 is cheap from the same data).
The `version` field reports a compatibility string in the GoToSocial style —
`"4.2.0 (compatible; dwk-workers/<version>)"` — because clients parse it for
feature detection. No `urls.streaming_api` is advertised (see non-goals);
clients fall back to polling.

**Valid-but-empty stubs (v1).** Clients call these at startup and several
hard-error on `404`/`500`, so each returns `200` with an empty-but-valid
body: `/api/v1/filters`, `/api/v2/filters`, `/api/v1/lists`,
`/api/v1/custom_emojis`, `/api/v1/announcements`, `/api/v1/follow_requests`,
`/api/v1/conversations`, `/api/v1/favourites`, `/api/v1/bookmarks`,
and `/api/v1/preferences` (defaults object). The stub roster is data-driven
in the router so conformance
runs can grow it without new code paths. Everything else under `/api/`
returns Mastodon's error shape (`404` + `{"error": "..."}`).

### IDs and pagination

Mastodon IDs must be strings that sort chronologically, and enough clients
parse them as 64-bit integers that they must be numeric. Entries use
**Mastodon's own snowflake scheme**: `(received_at_ms << 16) | (seq & 0xFFFF)`
rendered as a decimal string — chronologically ordered, unique per actor
(the DO's `seq` breaks same-millisecond ties), and derivable from existing
columns with no schema change. The DO route translates snowflakes back to
`seq` bounds for its SQL cursor. List endpoints honor `limit` (clamped),
`max_id`, `since_id`, `min_id` and return RFC 8288 `Link: rel="next"/"prev"`
headers, which is how every client pages.

### Entity mapping (AS2 → Mastodon)

Pure functions in `@dwk/mastodon-api`, fixture-tested:

- **Timeline** (`Status`): `Create` rows whose `object_type` is a post shape
  (`Note`/`Article`/`Page`/`Video`) plus `Announce` rows. Object `content`
  passes through a small allowlist HTML sanitizer at read time (the stored
  JSON is attacker-supplied; budget-friendly — no heavy sanitizer deps).
  `attachment` → `media_attachments` (type, `url`, `description` ← `name`,
  `blurhash`); `summary` → `spoiler_text` with `sensitive`; `inReplyTo` →
  `in_reply_to_id` when it resolves to a local snowflake, else null.
  Counters (`replies_count`, `reblogs_count`, `favourites_count`) are
  computed cheaply where possible and `0` otherwise — clients render zeros
  fine. `uri`/`url` carry the object's real IRI, so "open in browser" works.
- **FEP-1b12 provenance** maps onto vocabulary clients already have:
  a row with `relayed_by` set serializes as a **reblog** — outer `Status`
  attributed to the relaying group's account, `reblog` carrying the inner
  post. That renders as "boosted by <community>" in every client and
  satisfies the MCP-spec rule that read surfaces MUST expose the
  relayed-vs-directly-signed distinction.
- **Notifications** (`Notification`): `Follow` → `follow`; `Like` →
  `favourite`; `Announce` of a local object → `reblog`; `Create` whose
  object `inReplyTo` points into the actor's namespace or whose
  `tag`/`to`/`cc` mention the actor → `mention` (with the reply as
  `status`). Rows that fit no type are omitted from this endpoint (they
  remain visible to the MCP tool).
- **Accounts**: the owner's `Account`/`CredentialAccount` comes from
  `ActorProfile` config + `__stats` counts (`source` filled with defaults).
  Remote accounts are **synthesized best-effort from the stored activity
  JSON** (actor IRI → `username`/`acct`/`url`; embedded actor documents used
  when present; `avatar`/`header` fall back to a bundled static default —
  the fields are required and some clients crash on their absence). Every
  required field of `Account`, `Status`, and `Notification` is emitted; the
  per-field tables live in the package spec at implementation time.

Remote media and avatar URLs are passed through, not proxied — the client
fetches the origin server directly (a privacy delta vs Mastodon's media
proxy; documented, acceptable for a single-owner deployment).

**Actor-profile hydration (phase 3).** Synthesized accounts render with
guessed handles and default avatars. A small `actor_cache` table in the DO,
filled by the same queued, alarm-driven fetch machinery the follow-accept
path already uses (never inline in a request), upgrades display names and
avatars once per actor. Additive, and deliberately not a v1 blocker.

## Composition, catalog, and route claims

New catalog worker entry (id `mastodon-api`, forever-stable; group
`social`; `requires: ["activitypub"]`), with resources `ACTOR` (the shared
DO binding — same name the `activitypub` entry declares; composers
deduplicate) and `AUTH_DB` (shared D1). Route claims:

- `/api/v1/` and `/api/v2/` — `prefix` claims (the Mastodon API root is a
  delegated subtree, the same justification as `/users/` and `/xrpc/`), with
  `specificationURL: https://docs.joinmastodon.org/api/`.
- `/oauth/authorize` (`GET`), `/oauth/token` (`POST`), `/oauth/revoke`
  (`POST`) — `exact`, `authorityBinding: true`. **No overlap** with
  `indieauth`'s claims (`/authorize`, `/token`, `/revocation` — different
  paths), so both identity surfaces mount on one origin; the catalog gate's
  overlap rule verifies this mechanically. Mastodon clients hardcode the
  `/oauth/*` paths relative to the instance base URL, so these claims are
  effectively fixed despite being remountable in principle.

The handler mounted by composers is `@dwk/activitypub`'s
`createActivitypubMastodonApi` (as the catalog's webdav entries reference
`createSolidPodWebdav`, the composed adapter, not the bare core). The
conformance target adds one mount matching `/api/` and the three `/oauth/*`
paths — which also finally gives `conformance.dwk.io` the inbox read path
`pixelfed-qa.md` step 4 lacked.

Config (factory-injected per the composition contract): instance metadata
(`title`, `description`, contact email, languages, thumbnail), the approval
hook, token lifetime overrides, page-size ceiling, and the shared
`ResolvedConfig`/`ACTOR` wiring supplied by the adapter.

## Runtime budget

Reads are `pageSize`-bounded DO SQLite queries plus per-row `JSON.parse` of
activities already capped at ingest — no R2 bodies, no full-table scans, no
buffering. The pure mapping layer adds no dependencies beyond what the repo
ships; the sanitizer is a small allowlist walker, not a parser dependency.
Auth adds one D1 point-read per request. Nothing approaches the 128 MB /
script-size ceilings.

## Security considerations

- **Attacker-supplied content**: everything served from the inbox originated
  from remote servers. HTML is sanitized at read time; entity fields are
  emitted from typed extraction, never spread from stored JSON.
- **Bearer-token exception**: see Decision 2 — read-only scope surface,
  isolated audience, hashed at rest, revocable; never accepted by any
  DPoP-bound surface.
- **OAuth hygiene**: exact-match redirect URIs; single-use codes
  (conditional-UPDATE redemption); PKCE verified when offered; `state`
  round-tripped untouched; client secrets hashed at rest; the approval hook
  is the only place owner credentials exist.
- **No enumeration**: `/api/v1/accounts/:id` serves only the owner and
  actors already present in stored activities — it is not a general remote
  lookup and makes no outbound fetches in the request path (the phase-3
  hydration is queued and SSRF-guarded via `@dwk/safe-fetch` like every
  other outbound fetch).

## Non-goals (v1)

- **Posting or any write** through the client API (`POST /api/v1/statuses`,
  follow/unfollow, favourite, boost). Publishing stays with
  micropub/MCP/`/publish`. This keeps the bearer-token exception defensible;
  revisiting it is a separate design with real authz consequences.
- **Streaming API** (WebSocket/SSE). Clients poll when no streaming URL is
  advertised. The DO could serve WebSockets later (hibernation API), but not
  in v1.
- **Web Push** (`/api/v1/push/subscription` → `404`; no `vapid_key` in the
  app entity — one of the quirks the client matrix must confirm real apps
  tolerate).
- **Multi-account** — one actor per deployment, as everywhere in this repo.
- **Search, trends, directories, polls, filters that filter** — stubbed or
  absent per the roster above.

## Conformance

The suite is "real clients log in and render", not a rocks-style harness:

- New manual runbook `conformance/mastodon-client-qa.md` (companion to
  `pixelfed-qa.md`): against the deployed conformance target, for each
  client in the matrix — **Pixelfed's own app** (the platform this gap was
  discovered against) and **Tusky** (generic Mastodon client), with web
  clients (Elk/Phanpy/Pinafore) as a stretch row — record: app registration
  succeeds; OAuth round-trip completes; `verify_credentials` renders the
  owner profile; home timeline renders (media, CW, alt text); notifications
  render the pixelfed-qa step-4 like + reply.
- `conformance/status.json` gains a `mastodon-client-api` suite for
  `@dwk/mastodon-api` with per-client manual targets (`pixelfed-app`,
  `tusky`), `pending` until a hosted run passes — release-gated like every
  other suite.
- Colocated tests: entity mapping against captured AS2 fixtures (Node);
  OAuth flow + store + router under workerd (Miniflare D1), matching the
  webdav test split.

## Phasing

1. **Auth + identity**: `@dwk/oauth` client-read seam addition; new package
   scaffold; apps/authorize/token/revoke; `instance` (v1+v2);
   `verify_credentials`; stub roster. Acceptance: a real client completes
   login and shows the owner account.
2. **Read surface**: `__client/*` DO routes + extended `__stats` in
   `@dwk/activitypub`; timelines/home; notifications; statuses/:id;
   accounts/:id; snowflake pagination. Acceptance: the pixelfed-qa step-4
   like + reply are visible in a real client; runbook + status.json land.
3. **Fidelity**: actor-profile hydration cache; counters; any quirks the
   client matrix surfaces (each recorded in the runbook, fixed, and
   fixture-tested).

Each phase is independently shippable and changeset-recorded; phases 2–3
change `@dwk/activitypub` only additively (internal routes, one export).

## Open questions

- ~~Marker persistence~~ — **resolved (#327 discussion): real storage in
  v1.** Markers need no DO surface after all — per-account state with one
  account is two D1 rows (`mastodon_markers`), one store method and two
  thin handlers, so clients resume at the owner's read position from day
  one (see the endpoint roster and Storage).
- **`client_credentials` necessity** — listed SHOULD; confirm during the
  phase-1 client matrix whether the target clients actually require it and
  drop it from scope if none do.
- **Home-timeline completeness** — v1 serves the inbox (posts *received*
  from followed actors). Mastodon's home also shows the owner's own posts;
  merging `outbox` rows into the timeline needs an id-space decision (a
  source bit in the snowflake) and is deferred until a client-matrix run
  shows it matters for the read-your-notifications use case.
- **Naming** — `@dwk/mastodon-api` here; the issue floated
  `@dwk/mastodon-client-api`. Decide before the catalog id (forever-stable)
  lands in phase 1.
