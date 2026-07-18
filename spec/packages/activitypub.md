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

## Conformance

- ActivityPub test suites and real-world federation against Mastodon. JSON-LD via
  [`@dwk/rdf`](rdf.md) — confirm the AS2 context is covered by its v1 JSON-LD
  subset ([open-questions.md](../open-questions.md) §4). See
  [conformance-and-testing.md](../conformance-and-testing.md).

## Multi-platform interop (design)

v1 interop targets Mastodon. The approved design for interoperating with
**Pixelfed**, **Lemmy**, and other fediverse platforms from the same single
actor — a typed object model (`Note`/`Article`/`Page` + attachments),
FEP-1b12 group *participation* (follow `Group`s, `audience` targeting,
`Announce` unwrapping, `Dislike`), and client publish shaping — lives in
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
