# `@dwk/activitypub`

| | |
|---|---|
| **Type** | endpoint + Durable Object |
| **Ships a DO?** | **yes** — the per-actor Durable Object class |
| **Standard** | [ActivityPub](https://www.w3.org/TR/activitypub/) + [ActivityStreams 2.0](https://www.w3.org/TR/activitystreams-core/) |
| **Status** | implemented (unreleased) — tracked in [#58](https://github.com/davidwkeith/workers/issues/58) |

A native ActivityPub actor rooted at the user's own domain — making the
self-owned presence a first-class fediverse citizen (followers, replies, boosts)
rather than a bridged guest. ActivityStreams 2.0 is JSON-LD, so it reuses
[`@dwk/rdf`](rdf.md) directly, and the package mirrors the architecture proven
in [`@dwk/solid-pod`](solid-pod.md).

## Architecture fit

This is the **second package after `@dwk/solid-pod` to ship a Durable Object**.
A stateless Worker front door serves `GET` actor/collection reads and routes
`POST /inbox`; the per-actor DO is the consistency authority for the inbox,
outbox, follower/following collections, delivery queue, and activity-`id` dedup.
Per [non-functional-requirements.md](../non-functional-requirements.md#consistency-rules-load-bearing),
authoritative state **MUST** live in the DO (SQLite) — **never KV**. R2 holds any
large media; bodies **MUST** stream and **MUST NOT** be buffered in the DO.

- **Depends on [`@dwk/http-signatures`](http-signatures.md)** to sign outbound
  deliveries and verify inbound `POST /inbox` signatures.
- **Depends on [`@dwk/webfinger`](webfinger.md)** for actor discovery.

## Functional requirements

### Actor & collections

- Serve the **actor** document and the `inbox`, `outbox`, `followers`,
  `following` collections as paged `OrderedCollection`s. The actor document is
  served as `application/activity+json`, content-negotiating to the
  `application/ld+json; profile="…activitystreams"` variant when a strict client
  asks for it (§3.2).
- The actor document carries a **FEP-2c59 `webfinger` back-link** — its
  canonical `acct:<username>@<domain>` handle — so a peer can validate the
  handle ↔ actor mapping without a reverse lookup. The handle domain defaults to
  the actor-URL hostname (no port) and is overridable via `acctDomain` config
  (Mastodon 4.6).
- When the owner sets them, the actor document federates the Mastodon 4.6
  **profile-preference flags** `showFeatured` / `showMedia` /
  `showRepliesInMedia` (toot namespace), advertising which profile tabs are
  exposed. Unset flags are omitted.
- Optionally serve and advertise an instance-level **shared inbox** at
  `${baseUrl}/inbox` (§4.1 / §7.1.3) via `endpoints.sharedInbox`, so large peers
  can batch-deliver. Enabled by default; the single actor is the only recipient,
  so a batched delivery is processed for it.

### Server-to-server (federation)

- Inbound `POST /inbox`: verify the HTTP signature, dedup by activity `id`, and
  handle `Follow` / `Undo` / `Create` / `Update` / `Like` / `Announce` /
  `Delete`. A **temporary** signature-verification failure — the signer's key
  could not be resolved (e.g. their server was briefly unreachable) — answers
  **`503` + `Retry-After`** so the peer redelivers, rather than `401` which
  permanently drops the activity (Mastodon 4.6). Cryptographic/format failures
  stay `401`.
- Outbound delivery: fan out activities to follower inboxes with retry/backoff
  via **DO alarms** (and a Queue where composed), signing each request.
- Auto-`Accept`-on-`Follow`/`Join` inbox resolution is queued, not inline
  (#220): the DO is single-threaded, so resolving a remote actor's inbox
  (an outbound fetch, up to `OUTBOUND_TIMEOUT_MS`) while handling the inbound
  POST would hold the object's input gate for every other request to that
  actor. A `pending_accept` row records the actor + built `Accept` and the DO
  returns immediately; the alarm resolves the inbox and hands the `Accept` to
  the ordinary delivery queue, with the same backoff/max-attempts policy.

### Events & RSVPs (calendar/events epic #167 / #171)

The Fediverse layer of the calendar/events epic — the ActivityPub mirror of an
Indie RSVP, kept semantically aligned with the `@dwk/webmention`/`@dwk/micropub`
RSVP so an `h-event`, a `VEVENT`, and an AS2 `Event` are three serializations of
one record.

- **Emit `Event` objects.** `calendarEventToActivityStreams` (the
  `CalendarEvent → AS2 Event` adapter) serializes the canonical
  [`@dwk/calendar`](calendar.md) event to an ActivityStreams 2.0 `Event` (`name`,
  `content`, `startTime`/`endTime`, `location` as `Place`, `url`, `tag`), which
  the owner publishes through the existing `POST <actor>/outbox` seam — wrapped in
  a `Create` and fanned out like any other object. The adapter lives **here** in
  the endpoint, not in the cross-standard `@dwk/calendar` lib (the hard
  cross-standard-lib rule); the lib carries no Fediverse imports.
- **Inbound `Join` / `Leave`.** A `Join` targeting an event this actor owns
  records the participant; a `Leave` withdraws the RSVP. Participation is
  authoritative DO state (the `attendees` table), **never KV**. Only RSVPs to an
  event we own (a local resource) are recorded, so the actor cannot be used to
  amplify arbitrary RSVPs, and — because the front door enforces `actor ===
  signer` — a participant can only act on their own RSVP.
- **Optional `Accept`/`Reject` of joins.** Unless the owner sets
  `manuallyApprovesJoins`, a `Join` is auto-`Accept`ed (recorded `accepted`, a
  signed `Accept` delivered to the participant's inbox), mirroring the
  auto-`Accept`-on-`Follow` path. With `manuallyApprovesJoins`, the participant
  is recorded `pending` and no `Accept` is sent; emitting the eventual
  `Accept`/`Reject` is a C2S concern (out of scope for v1, as with manual
  follower approval).

### Owner follower control (#447)

An actor's owner MUST be able to remove and block a follower; without it the
only remedy against an abusive follower is rotating the actor identity, which
breaks federation with every legitimate follower. The operation rides the
existing owner publish seam (`POST <actor>/outbox`, same bearer token) rather
than a new endpoint, because what the owner is asking for *is* an AS2 activity.

- **Follower-control activities** are `Reject` (of a `Follow`), `Block`, and
  `Undo(Block)`. Each names **one** actor and is routed to that actor's inbox
  alone through the targeted queue an owner `Follow` already uses — never the
  follower fan-out, which is what an owner-published `Reject`/`Block` would
  otherwise have got.
- **They are private.** A follower-control activity is **never** written to the
  outbox: the outbox is served publicly, so an outbox row would publish the
  owner's moderation decisions. The response is `202` (no addressable resource
  was created) carrying the normalized activity: its `id` is a fragment of the
  actor IRI rather than an outbox IRI that would dereference to `404`, and its
  addressing is rewritten to the single recipient, so a `cc` copied from an
  ordinary post cannot claim an audience that was never delivered to.
- **`Reject`** drops the `followers` row and delivers a canonical
  `Reject(Follow)` — `object.actor` the follower, `object.object` this actor,
  and `object.id` the original `Follow`'s IRI when one was recorded (the
  `followers.follow_id` column, populated by the inbound `Follow`). The owner
  may name the target as the embedded `Follow`, as the follower's actor IRI, or
  as the recorded `Follow`'s IRI; all three normalize to the same delivered
  body.
- **`Block`** additionally records the actor in the durable blocklist and
  severs the relationship in both directions (both the `followers` and the
  `following` row), since the receiving server does the same. Every subsequent
  inbound activity from a blocked actor is refused with `403` — not just a
  re-`Follow`, since a block that still accepted their replies, likes, and
  mentions would only be half a block — and the refusal precedes dedup, so a
  blocked actor never consumes a `seen` row.
- **`Undo(Block)`** deletes the blocklist row and tells the peer. The follow
  relationship is not restored; re-following is the unblocked actor's own
  decision to make again.
- **`?skipDelivery=1`** keeps its literal meaning on these activities: the local
  state change still applies, only the federated notification is suppressed — a
  silent removal.
- **Owner Accept / Group moderation (#473).** `Accept` (confirm a pending
  follower) and `Remove` (ban a member / un-announce a post, `Group` actors
  only) published to `POST <actor>/outbox` are routed the same way as
  `Reject`/`Block`: `Accept` delivers privately to the one follower it names
  and marks the `followers` row confirmed; `Remove` reuses exactly the same
  moderator-`Remove` effects as the inbound path (`#onModerationRemove`) but
  is authorized by the bearer `publishToken` alone — the owner is implicitly
  the top moderator of their own actor, independent of the configured
  `moderators` allowlist.
- **`GET <actor>/blocked`** returns the blocklist (`{ items, total }`, flat JSON
  rather than an AS2 collection, unpaged) behind the same bearer token. It is
  never public: a block that can be created but never reviewed could not be
  undone.
- **`GET <actor>/follow_requests`** (#487) returns pending followers awaiting
  the owner's `Accept` — `{ items, total }`, flat JSON, unpaged, behind the
  same bearer token as `/blocked`, oldest first. Items are
  `{ actor, addedAt }` with `addedAt` an ISO 8601 string, matching
  `/blocked`'s `{ actor, blockedAt }` shape — not the raw storage row's
  snake_case epoch ms, which stays an internal-only detail of the
  internal-marker-gated `__client/follow_requests` route `@dwk/mastodon-api`'s
  `GET /api/v1/follow_requests` already uses (#473). This is a bearer-gated
  equivalent of that route: an owner-facing client (e.g. a moderation UI) can
  list the approval queue
  without standing up a separate OAuth flow just to see who is pending.

### Group actors (communities, FEP-1b12 producer side, #376)

`actor.type` (default `"Person"`) may be set to `"Group"` to host a FEP-1b12
community — the concrete use case is Anglesite V-5 communities. See
[fediverse-interop.md](../fediverse-interop.md) Capability 4 for the full
design; summary:

- **Members are followers.** A `Follow`, or a `Join`/`Leave` that targets the
  Group actor itself (as opposed to one of its owned events — the existing
  calendar-RSVP path, #171), is recorded exactly like `Follow`/`Undo(Follow)`,
  including the `manuallyApprovesFollowers` approval gate.
- **Member posts are boosted.** A `Create` from a current member is wrapped in
  a Group-authored `Announce` and fanned out to the membership. A non-member's
  post is stored but never announced.
- **Moderation** is gated by a `moderators` actor-IRI allowlist and expressed
  as AS2 `Remove`, disambiguated by `target`: banning a member (drops them and
  rejects their future activities) or un-announcing a post (tombstones it and
  broadcasts `Undo(Announce)`).

### NodeInfo

- The `/.well-known/nodeinfo` discovery document advertises both the
  `schema/2.0` and `schema/2.1` documents (many consumers still request 2.0),
  each largely-static and **static enough for Anglesite to serve**. Only the
  live `usage` counts are dynamic — decide per deployment whether those counts
  justify a Worker route or are omitted.

### Client-to-server (optional)

- C2S authoring is **out of scope for v1**; [`@dwk/micropub`](micropub.md)
  already covers authoring, and a publish → `Create` fan-out is the integration
  seam.
- **Backfill / quiet-insert (#451).** `POST <actor>/outbox` and
  `POST <actor>/publish` accept `?skipDelivery=1`, gated by the same
  bearer-token publish check as an ordinary owner publish. When set, the
  activity is written to the outbox and the response returns immediately —
  follower fan-out, `Follow`/`Undo` relationship routing, community
  (`audience`) delivery, and arming the delivery alarm are all skipped. Any
  other value (including an empty `?skipDelivery=`) is rejected with `400`
  rather than silently falling through to a live, notification-fanning
  publish. This is the seam a trusted owner script uses to sync
  pre-existing content into its own outbox without notification-blasting
  current followers.
- **Backdated `published`.** Both endpoints accept a caller-supplied
  `published` (a `Date.parse`-interpretable string, renormalized to
  canonical `xsd:dateTime` via `.toISOString()`) instead of always stamping
  the activity with `now`; an unparseable value is rejected with `400`. The
  outbox `OrderedCollection` orders by `published_at` (backed by
  `idx_outbox_published_at`) rather than insertion order, so a backfilled
  post sorts into its historical position among already-synced content.

## Bindings (declared `Env` fragment)

- **Durable Object namespace** for the per-actor class (exported by this package).
- **R2 bucket** for media bodies.
- A **queue** (optional) for outbound delivery fan-out.

## Config

- `baseUrl` / domain (the actor identity root).
- Signing key material (secret binding) shared with the actor's published key.
- Delivery retry / backoff policy.
- `manuallyApprovesJoins` — hold inbound event RSVPs (`Join`) `pending` instead
  of auto-`Accept`ing them. Defaults to `false`.
- `actor.type` — `"Person"` (default) or `"Group"` (#376); see "Group actors"
  above.
- `moderators` — actor IRIs authorized to moderate a `Group` actor via
  `Remove`. Defaults to empty; ignored for a `Person` actor.

## Conformance

- ActivityPub test suites and real-world federation against Mastodon. JSON-LD via
  [`@dwk/rdf`](rdf.md) — confirm the AS2 context is covered by its v1 JSON-LD
  subset ([open-questions.md](../open-questions.md) §4). See
  [conformance-and-testing.md](../conformance-and-testing.md).

## Mastodon-compatible client API (design)

A read-only Mastodon client API — so the owner can log in with an
off-the-shelf fediverse app (Pixelfed, Tusky) and browse their own
notifications and timeline — is designed in
[mastodon-client-api.md](../mastodon-client-api.md) (#327). It lives in a
separate package (`@dwk/mastodon-api`); this package's additive part is a
`createActivitypubMastodonApi` adapter export plus internal-header-gated
`__client/*` DO read routes and extended `__stats` counts, mirroring how
`createSolidPodWebdav` composes `@dwk/webdav`. Federation behavior is
unchanged.

## Multi-platform interop (design)

v1 interop targets Mastodon. The approved design for interoperating with
**Pixelfed**, **Lemmy**, and other fediverse platforms from the same single
actor — a typed object model (`Note`/`Article`/`Page` + attachments),
FEP-1b12 group *participation* (follow `Group`s, `audience` targeting,
`Announce` unwrapping, `Dislike`) and now *hosting* (see "Group actors"
above, #376), and client publish shaping — lives in
[fediverse-interop.md](../fediverse-interop.md). It is additive; nothing in it
changes the Mastodon-facing behavior specified above.

## Open questions

- Authoring relationship with `@dwk/micropub` (publish → `Create`) — the
  publish-shaping phase of [fediverse-interop.md](../fediverse-interop.md)
  resolves the *shape* of the seam (micropub holds the adapter, outbox `POST`
  is the seam); the exact `PostInput` envelope on that `POST` is still open
  there.
- Actor identity overlap with the eventual Solid-OIDC OP rooted at the same
  domain (see [open-questions.md](../open-questions.md) §1).
