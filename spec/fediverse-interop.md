# Fediverse platform interop (Lemmy, Pixelfed, and beyond)

**Status: design — approved direction, not yet implemented.** This document
extends [`spec/packages/activitypub.md`](packages/activitypub.md); that spec
remains authoritative for everything it already covers (actor model, inbox
security, delivery, events). Tracked in
[#273](https://github.com/davidwkeith/workers/issues/273), with one child
issue per phase (#274, #275, #276).

## Motivation

`@dwk/activitypub` v1 makes the self-owned domain a first-class fediverse
citizen, but its interop target is **Mastodon** (FEP-2c59 back-link, `toot:`
profile flags, 503-on-temporary-signature-failure, etc.). The composed Worker
should let **one user account interoperate with arbitrary fediverse
platforms** — today concretely **Pixelfed** (photos) and **Lemmy**
(communities/threadiverse) — without the client caring which platform a peer
runs.

Two properties of the current implementation make this tractable:

1. The DO already stores inbound activities **verbatim and opaquely** — nothing
   breaks when a `Page` or a `Dislike` arrives; it is stored and ignored.
   Interop work is therefore *additive classification and behavior*, not a
   rewrite.
2. The actor is already a plain AS2 `Person` with draft-cavage RSA signatures —
   exactly what Mastodon, Pixelfed, and Lemmy all speak today.

## Research summary: how the platforms differ

| | Mastodon | Pixelfed | Lemmy |
| --- | --- | --- | --- |
| Peer actor types | `Person` | `Person` (+ instance `Application` for signed GETs) | `Person` (users), **`Group` (communities)** |
| Top-level post object | `Note` | `Note` **with media `attachment`s** | **`Page`** (with `name` title) |
| Comment/reply object | `Note` + `inReplyTo` | `Note` + `inReplyTo` | `Note` + `inReplyTo` |
| Interaction verbs | Like, Announce | Like, Announce | Like, **Dislike** (votes) |
| Distribution | direct fan-out to followers | direct fan-out | **FEP-1b12**: post is delivered to the Group; the Group wraps it in `Announce` and fans out to group followers |
| Signatures | draft-cavage RSA (authorized fetch) | draft-cavage RSA (authorized fetch) | draft-cavage RSA |
| Content constraint | — | timeline **only shows posts with image/video attachments**; text-only posts are invisible | top-level posts need a `name` (title); `audience` names the community |
| Platform extensions | `toot:` (sensitive, discoverable, …) | blurhash, comment-control `capabilities`, `Story` (Pixelfed-to-Pixelfed only) | `audience` property, vote counting via attributed Like/Dislike |

Key takeaways:

- **Pixelfed needs no protocol changes at all.** It is Mastodon-shaped
  federation; what it needs is *content shaping* — the ability to publish a
  `Note` carrying `Image`/`Video` attachments (with alt text, `sensitive`,
  optionally blurhash). This is an object-model gap, not a federation gap.
- **Lemmy needs one real protocol capability: FEP-1b12 group participation**
  as a *client/participant* — following `Group` actors, addressing posts to a
  community, and unwrapping the `Announce(<activity>)` envelopes a community
  relays to its followers. FEP-1b12 is also what Friendica, Hubzilla, PieFed,
  Mbin, and PeerTube channels speak, so this single capability covers the
  whole "group-shaped" half of the fediverse.
- **PeerTube / Mobilizon and others** then come nearly for free: PeerTube
  channels are FEP-1b12 `Group`s announcing `Video` objects; Mobilizon is
  already partially covered by the events layer (`Event`/`Join`/`Leave`).

## Design principle: capabilities, not platform adapters

We explicitly do **not** add a `platform: "lemmy" | "pixelfed"` switch, a
per-platform module, or platform sniffing (NodeInfo `software.name`
dispatching). Platforms converge on shared vocabulary (AS2 + FEPs); coding to
the vocabulary keeps the package spec-driven and makes unlisted platforms work
by default. "Support for platform X" decomposes into three
platform-agnostic capabilities plus documentation:

1. a **typed object model** (post shapes: `Note`, `Article`, `Page`,
   attachments),
2. **FEP-1b12 group participation** (follow Groups, target `audience`, unwrap
   `Announce`),
3. **client publish shaping** (micropub / MCP / outbox `POST` map one
   canonical post to the right AS2 shape),

with a per-platform **interop profile table** living in docs/conformance, not
in code.

## Capability 1 — typed object model (`objects.ts`)

New internal module `packages/activitypub/src/objects.ts`, exported from
`index.ts`:

- **Canonical post input.** A `PostInput` plain-data shape the outbox and
  clients share:

  ```ts
  interface PostAttachment {
    type: "Image" | "Video" | "Audio" | "Document";
    url: string;
    mediaType?: string; // e.g. "image/jpeg"
    name?: string; // alt text — required for images by lint, not by schema
    blurhash?: string; // toot:blurhash passthrough
    width?: number;
    height?: number;
  }

  interface PostInput {
    kind: "note" | "article" | "page";
    content: string; // sanitized HTML
    name?: string; // title — REQUIRED when kind === "page"
    summary?: string; // content warning
    sensitive?: boolean; // as:sensitive
    attachments?: PostAttachment[];
    inReplyTo?: string;
    audience?: string; // Group actor IRI (community target)
    tags?: string[]; // hashtags
    to?: string[]; // advanced override; defaults derived
    cc?: string[]; // advanced override — mentions / secondary audiences
  }
  ```

- **Builders** `postToObject(input, iris, now): AS2Object` producing `Note` /
  `Article` / `Page` with correct `attributedTo`, `published`, `attachment`,
  `sensitive`, `summary`, `tag`, and — when `audience` is set — `audience`
  plus the Group in `to`. Object `id`s are minted under the actor's namespace
  exactly as outbox activities are today (server-assigned).
- **Classification, not validation, inbound.** The inbox stays liberal
  (unknown types are still stored and ignored — current behavior is a
  feature). Additively, `#onCreate`/`#onUpdate`/`#onAnnounce` record a
  `object_type` column (`Note`, `Page`, `Article`, `Video`, `Event`, other) and
  the `audience` IRI when present, so reads (`activitypub_list_inbox` MCP
  tool, a future microsub bridge) can filter "community posts" vs "statuses"
  without re-parsing JSON.
- The existing `events.ts` `Event` builder is unchanged; `objects.ts` is its
  sibling for the social post shapes. Neither leaks into `@dwk/calendar` or
  other cross-standard libs (hard rule).

**Pixelfed acceptance criterion:** publishing
`{kind: "note", content, attachments: [image…], sensitive?}` through the
outbox produces a post that renders in a Pixelfed timeline (media present,
alt text preserved, CW respected), verified manually against a live Pixelfed
peer.

## Capability 2 — FEP-1b12 group participation

The account participates in communities; it does **not** host them (see
non-goals). Five additive changes (§2.1–2.3 and §2.5 to `ActivityPubObject`;
§2.4 spans `@dwk/webfinger` + the AP flows):

### 2.1 Follow-target typing

`following` rows gain `actor_type` (`Person` | `Group` | `Service` | …) and
`shared_inbox`/`inbox` columns. Populated when the outbound `Follow` is
prepared (the actor document is already fetched to resolve the inbox — same
queued, alarm-driven pattern as `pending_accept`, never inline in the inbox
POST path). Rows predating the migration have `actor_type IS NULL` and are
**lazily backfilled**: the alarm tick resolves each `NULL`-typed row's actor
document through the same queued fetch, so a pre-existing `Group` follow
starts qualifying for §2.2 unwrapping once backfilled — no unfollow/re-follow
required. Nothing else changes for `Person` follows.

### 2.2 Inbound `Announce` unwrapping

Today `Announce` is stored + maybe-forwarded. Additively:

- If `Announce.object` is an **embedded activity** (`Create`/`Update`/
  `Delete`/`Like`/`Dislike` — the FEP-1b12 envelope) **and** the announcing
  actor is a `Group` in `following`, unwrap: dedup on the **inner** activity
  `id` (recorded in `seen` alongside the outer id), classify and store the
  inner object attributed to its real author, tagged with the group as
  `audience`. The outer `Announce` is what the signature verified (the edge
  already enforces `actor === signer`); the inner activity is **relayed,
  unsigned content** — treated exactly like a boost: attribution recorded,
  trust scoped to "the group we chose to follow relayed this". Because a
  malicious or compromised group could relay fabricated activities under any
  author's name, relayed rows are **never confusable with verified ones**:
  the stored row records the relaying group in a `relayed_by` column, and
  every read surface (MCP tools, a future microsub bridge) MUST expose the
  distinction between directly-signed activities and group-relayed content.
- **Async origin verification, on by default, in two tiers.** Relayed
  activities are verified against their origin (fetch the inner object by its
  `id` via `@dwk/safe-fetch`) — always asynchronously, never in the inbox
  POST path:
  - **Content tier** (`Create`/`Update`/`Delete`): enqueued for verification
    immediately on arrival and picked up by the next alarm tick, with the
    delivery queue's backoff/max-attempts policy. Rows carry
    `verify_state` (`pending` → `verified` | `failed`); pending content is
    stored and readable (already marked `relayed_by`), and a failed
    verification deletes the row and emits a metric.
  - **Vote tier** (`Like`/`Dislike`): accumulated and verified in periodic
    batched sweeps, coalesced per origin instance (votes burst from the same
    server). Counts are provisional until swept.

  `verifyRelayedObjects` config: `"tiered"` (default) | `"immediate"` (all
  activities in the content tier) | `"off"` (trust the followed group; rows
  stay `pending` and rely on `relayed_by` provenance alone).
- `Announce` of a bare object IRI (a Mastodon boost) keeps today's behavior.

### 2.3 Posting to a community

A `PostInput` with `audience` set (a `Group` IRI, from `following`) publishes
`Create(Page|Note)` with `audience: <group>`, `to: [<group>, Public]`,
`cc: [<followers>]`, and delivery **to the group's inbox** in addition to the
normal follower fan-out. The community then `Announce`s it to group members
per FEP-1b12 — we never fan out to the community's members ourselves.
Replies/comments inside a community are `Note` + `inReplyTo` with the same
`audience`, keeping the community "in the loop" (the interop failure mode of
Mastodon replies to Lemmy).

### 2.4 Community discovery

Resolving a community handle (`!birding@lemmy.ml`) or any `acct:` handle to
its actor IRI is a **remote WebFinger lookup**, and it lives in two layers
per the cross-standard-lib rule:

- **`@dwk/webfinger`** gains the pure client half of the protocol: build the
  `/.well-known/webfinger?resource=acct:…` query URL, parse/validate the JRD
  response, select the `self` link (`application/activity+json`). Plain-data
  in/out with an **injected `fetch`** — the package stays Workers-free and
  makes no network calls of its own.
- **`@dwk/activitypub`** wires that helper to `@dwk/safe-fetch` (the host is
  user-supplied — SSRF rules apply) inside its follow and publish flows, so
  the owner can follow or target a community by handle. A read-scoped
  `activitypub_resolve` MCP tool exposing the same resolution is a natural
  phase-3 addition alongside `activitypub_publish`.

### 2.5 `Dislike`

- Inbound: handled like `Like` (stored, deduped, maybe-forwarded).
- Outbound: `Dislike` added to the activity types `#asOutboxActivity`
  recognizes (a Lemmy downvote). A vote's `object` names the content being
  voted on, not an actor, so there is no inbox to derive from it the way a
  `Follow`'s `object` (an actor) yields one — the raw outbox `POST
  <actor>/outbox` therefore requires an explicit `audience` naming the
  community, and delivers the `Like`/`Dislike` to that community's inbox (in
  addition to the owner's own followers), the same mechanism community posts
  already use (`#deliverToAudience`, shared by `#publish` and `#publishPost`).
  A vote with no `audience` only reaches followers — it does not reach the
  community at all.

**Lemmy acceptance criteria:** (a) `Follow` a community from this actor and
receive/unwrap its announced posts; (b) publish a titled `Page` into the
community and see it as a post; (c) reply and vote; verified manually against
a live Lemmy peer, with the announce-unwrap path also covered by an
automatable fedify peer test.

## Capability 3 — client publish shaping

The "single user account" is operated by clients through existing seams; each
maps its native vocabulary onto `PostInput`, keeping platform knowledge out of
the clients:

- **Publish endpoint** (owner, `publishToken`): a dedicated
  `POST <actor>/publish` accepts a bare `PostInput` JSON body, keeping
  `POST <actor>/outbox` purely AS2 (activities/objects, per AP §6) — no
  content-type sniffing or wrapper keys on the outbox. The endpoint validates
  the `PostInput`, builds the object via `objects.ts`, and hands it to the
  same internal publish path as the outbox. Because the actor is rooted at
  `/users/<username>`, the route is covered by the existing `/users/` prefix
  claim in `catalog.json` — no catalog change.
- **`@dwk/micropub`** (the designated authoring surface): the adapter lives in
  micropub (endpoint packages hold adapters, never libs). `h-entry` maps
  naturally — `photo` → `note` + attachments (Pixelfed-ready), `name` +
  `content` → `article`, and a **syndication target per followed community**
  (`q=syndicate-to` advertising `{uid: <group IRI>, name: "!birding@lemmy.ml"}`;
  `mp-syndicate-to` → a `page` post with that `audience`). This finally wires
  the micropub → outbox seam both specs already reserve.
- **`@dwk/mcp`**: a v3 tool contribution `activitypub_publish` (write-scoped,
  distinct from the read-only `activitypub_list_inbox`) taking `PostInput`,
  plus `audience` listing folded into existing reads. Agent-operable posting
  to any platform falls out of the same shape.

## Capability 4 — hosting `Group` actors (FEP-1b12 producer side, #376)

The concrete use case for the "Non-goals" deferral below arrived (Anglesite V-5
communities, Anglesite/Anglesite-app#339/#367): a hosted community is its own
`@dwk/activitypub` actor configured as a `Group` rather than a `Person`. Members
are followers — the same `followers` table, the same `manuallyApprovesFollowers`
approval gate — so the whole federation/delivery machinery (auto-`Accept`,
alarm-driven fan-out, SSRF-guarded delivery) is reused unchanged; only the actor
type and a handful of new inbound activity branches are additive.

- **`actor.type: "Group"`** (`ActorProfile.type`, default `"Person"`) is
  serialized as the actor document's AS2 `type`. Nothing else about the actor
  document changes.
- **Membership = followers.** A `Follow` targeting the Group works exactly as
  it does for a `Person`. FEP-1b12 senders (Lemmy) address membership as
  `Join`/`Leave` instead: a `Join`/`Leave` whose `object`/`target` names the
  Group actor itself (not one of its owned events — the existing calendar-RSVP
  `Join`/`Leave` path, #171, is unambiguously distinguished by target) is
  treated as `Follow`/`Undo(Follow)`, including the `manuallyApprovesFollowers`
  gate and the queued (never inline) auto-`Accept`.
- **Member-post → `Announce` fan-out.** A `Create` reaching the Group's inbox
  from a current member (a `followers` row) is wrapped in a Group-authored
  `Announce` (`to: [Public], cc: [followers]`) and fanned out to the whole
  membership via the same `followers`-table delivery loop `#publish` and
  `#maybeForward` already use. A non-member's `Create` is stored (as any
  inbound activity is) but never announced, so the actor cannot be used to
  amplify arbitrary content. `Update` is never re-announced — a member who
  already received the `Announce` resolves the edit through the object's `id`.
- **Moderation**, gated by a new `moderators: readonly string[]` config list
  (actor IRIs; checked against the HTTP-signature-verified signer, never the
  unverified `actor` field alone) and reusing the AS2 `Remove` activity,
  disambiguated by `target`:
  - `Remove { object: <member>, target: <followers collection> }` — **ban a
    member**: drop them from `followers` and record them in a new `banned`
    table; every subsequent activity from a banned actor is rejected (`403`)
    before it reaches any handler.
  - `Remove { object: <announce id>, target: <outbox collection> }` —
    **un-announce a post**: delete the `Announce` this Group authored for it,
    tombstone the relayed inbox copy (a nullable `removed_at` column, never a
    hard delete — moderation history survives), and fan out a self-signed
    `Undo(Announce)` to the membership so their servers retract the boost too.
- Interop targets: **Lemmy** and **Mastodon** consuming a hosted group (join,
  receive announced member posts, have a post/member moderated away). The
  `activitypub-federation` suite's `lemmy` manual target (already `pending` in
  `conformance/status.json` for the participant side) gains producer-side
  cases; see "Storage & config deltas" below for the new columns/tables.

## Interop profiles (docs + conformance, not code)

`spec/packages/activitypub.md` gains a short "interop profiles" appendix (or
this doc grows one at implementation time) recording, per platform, the
content shape it renders best — e.g. *Pixelfed: ≥1 image attachment, alt
text, sensitive flag; Lemmy: titled `Page` + `audience`; PeerTube: consume
only in v1*. `conformance/status.json` adds **manual targets** `pixelfed` and
`lemmy` next to the existing `node` (Mastodon) target for the
`activitypub-federation` suite (both `pending` until a hosted run passes),
and the fedify peer script grows announce-unwrap and Page cases.

## Storage & config deltas (summary)

- `following`: + `actor_type`, `inbox`, `shared_inbox`.
- `followers`: + `shared_inbox` (nullable), so the delivery queue can batch
  fan-out per shared inbox instead of one request per follower on the same
  instance — a delivery optimization, recorded when the `Follow` is accepted.
- `inbox`: + `object_type`, `audience`, `relayed_by`, `verify_state` (all
  nullable — classification and provenance; `relayed_by` marks group-relayed
  content and `verify_state` tracks its async origin verification, see §2.2),
  + `removed_at` (nullable — set when a moderator un-announces the post, #376
  Capability 4).
- `seen`: also records unwrapped inner-activity `id`s.
- `banned` (new table, #376): `actor` (primary key), `banned_at` — actors
  banned from a hosted `Group`; empty and unused for a `Person` actor.
- Config: + `verifyRelayedObjects?: "tiered" | "immediate" | "off"` (default
  `"tiered"`, see §2.2), + `moderators?: readonly string[]` (default empty,
  #376 Capability 4) authorizing `Remove`-based moderation on a `Group` actor.
  `ActorProfile` gains `type?: "Person" | "Group"` (default `"Person"`). No new
  bindings — attachments are **URL references**; media bytes live behind the
  micropub media endpoint / R2 as today, and the AP package still never
  buffers or hosts blobs itself.

Everything remains DO-SQLite authoritative state — never KV — per
[non-functional-requirements.md](non-functional-requirements.md).

## Non-goals

- **Pixelfed `Story` objects** (bearcap-gated, Pixelfed-to-Pixelfed only) and
  the comment-control `capabilities` extension beyond tolerating them inbound.
- **Video hosting** (PeerTube producer side). Consuming announced `Video`
  objects is covered by classification; serving video is not.
- **Platform client APIs** (Mastodon REST API, Lemmy HTTP API) *inside
  `@dwk/activitypub`*. Clients speak micropub/MCP/outbox to *this* Worker;
  only federation is multi-platform. A read-only Mastodon-compatible client
  API is now designed as a **separate optional package** reading the same DO
  through the internal seam — see
  [mastodon-client-api.md](mastodon-client-api.md) (#327); the federation
  package itself stays free of platform client vocabulary.
- **Per-platform actor sniffing or behavior switches** — see the design
  principle.

## Phasing

1. **Typed objects + publish shaping** (`objects.ts`, outbox `PostInput`,
   attachment support) — ships Pixelfed interop and improves Mastodon media
   posts. Smallest increment, no schema-migration risk beyond additive
   columns. ([#274](https://github.com/davidwkeith/workers/issues/274))
2. **FEP-1b12 participant** (follow typing, announce unwrap, `audience`
   targeting, `Dislike`) — ships Lemmy/threadiverse interop.
   ([#275](https://github.com/davidwkeith/workers/issues/275))
3. **Client wiring** (micropub adapter + syndication targets, MCP
   `activitypub_publish`) and the conformance-target additions.
   ([#276](https://github.com/davidwkeith/workers/issues/276))
4. **Hosting `Group` actors** (Capability 4, the FEP-1b12 producer side) —
   `actor.type: "Group"`, membership `Join`/`Leave` synonyms, member-post
   `Announce` fan-out, and `Remove`-based moderation.
   ([#376](https://github.com/davidwkeith/workers/issues/376))

Each phase is independently shippable and changeset-recorded; nothing here
alters published behavior for existing Mastodon federation.

## Appendix: interop profiles

The content shape each platform renders best — documentation, never code
(see the design principle). Confirm/refine these rows during the manual
conformance runs (`pixelfed` / `lemmy` targets in `conformance/status.json`,
#280).

| Platform | Post shape that renders best | Interactions | Notes |
| --- | --- | --- | --- |
| Mastodon | `note`; `article` renders as title + link on older versions | Like, Announce, replies | `summary` = CW; `sensitive` hides media; ≤4 attachments shown |
| Pixelfed | `note` with **≥1 image/video attachment** (alt text on each) | Like, Announce, replies | text-only posts never appear in timelines; blurhash passed through |
| Lemmy / PieFed / Mbin | `page` with `name` (title) + `audience` (community) | replies (`note` + `inReplyTo` + same `audience`), Like/Dislike votes | deliver to the community; it Announces to members (FEP-1b12) |
| Friendica / Hubzilla | `article` or `note`; groups per FEP-1b12 | Like, Announce, replies | rich HTML bodies render fully |
| PeerTube | consume-only in v1 (channels are FEP-1b12 `Group`s announcing `Video`) | Like, replies | `Video` objects classified on receipt; no video hosting |
| Mobilizon / Gancio | `Event` (via the events layer, #167) | `Join` / `Leave` RSVPs | already covered by `events.ts` |

## Open questions

- ~~Exact owner-publish envelope for `PostInput`~~ — **resolved**: a
  dedicated `POST <actor>/publish` endpoint (see Capability 3); the outbox
  stays purely AS2.
- ~~Should `verifyRelayedObjects` default on?~~ — **resolved**: on by
  default as an always-async, two-tier pipeline (content verified on the
  next alarm tick, votes in coalesced batched sweeps; see §2.2).
- ~~Where community discovery lives~~ — **resolved**: the pure JRD
  lookup/parsing helper joins `@dwk/webfinger` (injected `fetch`, no network
  of its own); `@dwk/activitypub` wires it to `@dwk/safe-fetch` in the
  follow/publish flows (see §2.4).
- RFC 9421 / Ed25519 signature adoption is tracked separately (#59, the
  `verifyInboxSignature` seam + `@dwk/http-signatures`); nothing in this
  design depends on it.
