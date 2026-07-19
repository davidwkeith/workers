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
  recognizes (a Lemmy downvote).

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
  content and `verify_state` tracks its async origin verification, see §2.2).
- `seen`: also records unwrapped inner-activity `id`s.
- Config: + `verifyRelayedObjects?: "tiered" | "immediate" | "off"` (default
  `"tiered"`, see §2.2). No new
  bindings — attachments are **URL references**; media bytes live behind the
  micropub media endpoint / R2 as today, and the AP package still never
  buffers or hosts blobs itself.

Everything remains DO-SQLite authoritative state — never KV — per
[non-functional-requirements.md](non-functional-requirements.md).

## Non-goals

- **Hosting `Group` actors** (being the Lemmy-style community server, FEP-1b12
  producer side). The DO is keyed per-actor so this is architecturally
  reachable, but it is a different product surface (moderation, membership,
  relay fan-out amplification) — explicitly deferred, revisit only with a
  concrete use case.
- **Pixelfed `Story` objects** (bearcap-gated, Pixelfed-to-Pixelfed only) and
  the comment-control `capabilities` extension beyond tolerating them inbound.
- **Video hosting** (PeerTube producer side). Consuming announced `Video`
  objects is covered by classification; serving video is not.
- **Platform client APIs** (Mastodon REST API, Lemmy HTTP API). Clients speak
  micropub/MCP/outbox to *this* Worker; only federation is multi-platform.
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

Each phase is independently shippable and changeset-recorded; nothing here
alters published behavior for existing Mastodon federation.

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
