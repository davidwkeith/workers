# @dwk/activitypub

## 1.0.0-beta.1

### Major Changes

- Synchronized `v1.0.0-beta.1` release: every package in the workspace is bumped
  to the same version for this coordinated beta milestone. After this release,
  `.changeset/config.json`'s `fixed` group is removed so packages resume
  independent versioning and drift apart again.

### Patch Changes

- Updated dependencies
  - @dwk/calendar@1.0.0-beta.1
  - @dwk/http-signatures@1.0.0-beta.1
  - @dwk/ldn@1.0.0-beta.1
  - @dwk/log@1.0.0-beta.1
  - @dwk/mastodon-api@1.0.0-beta.1
  - @dwk/mcp@1.0.0-beta.1
  - @dwk/safe-fetch@1.0.0-beta.1
  - @dwk/webfinger@1.0.0-beta.1

## 0.1.0-beta.6

### Minor Changes

- 49e29f8: Host FEP-1b12 `Group` actors — the producer side of a fediverse community
  (#376), the concrete use case being Anglesite V-5 communities. Set
  `actor.type: "Group"` (default `"Person"`) to serve a community rather than an
  individual: membership is recorded exactly like following (a `Follow`, or a
  `Join`/`Leave` that targets the Group actor itself rather than one of its owned
  events, honors the existing `manuallyApprovesFollowers` gate); a `Create` from a
  current member is wrapped in a Group-authored `Announce` and fanned out to the
  whole membership; and a new `moderators` actor-IRI allowlist authorizes AS2
  `Remove`-based moderation — banning a member (dropped from followers, future
  activities rejected) or un-announcing a post (tombstoned, `Undo(Announce)`
  broadcast to members).
- 20c4e9e: Serve the owner's own posts on account profiles, and stop 404ing the profile
  companion endpoints real clients call — the fixes for the quirks surfaced by
  the 2026-07-23 Ice Cubes client-QA run (conformance/mastodon-client-qa.md,
  issue #327).

  - **`@dwk/mastodon-api`:** new `GET /api/v1/accounts/:id/statuses` route —
    the owner id answers their own posts (newest-first, standard `Link`
    pagination) via the new optional `MastodonBackend.ownStatuses` seam
    method; remote account ids answer a valid-but-empty page (no remote
    status history is stored). `GET /api/v1/accounts/relationships` joins the
    exact-route stub roster (previously the dynamic `accounts/:id` pattern
    misread `relationships` as an account id and 404ed), and the dynamic
    profile companions `accounts/:id/{followers,following,featured_tags}`
    answer valid-but-empty pages.
  - **`@dwk/activitypub`:** the DO's `__client/timeline` accepts `source=1`
    to restrict a page to owner outbox posts (skipping the inbox scan
    entirely), and `buildMastodonBackend` implements `ownStatuses` over it.

- dc59912: Implement `follow` notifications (the deferred phase-2 gap): `@dwk/activitypub`'s `#onFollow` now stores a _new_ follower's `Follow` (or FEP-1b12 `Group` membership `Join`) in the actor's inbox — a re-Follow from a still-recorded follower is not a fresh notification — and the `__client/notifications` classifier surfaces those rows; `@dwk/mastodon-api`'s `notificationEntity` maps them to Mastodon's `type: "follow"` (account attached, `status: null`), so clients like Tusky and Pixelfed now see new-follower notifications. Storing via the existing inbox path also queues the follower's actor-profile fetch, so the notification renders with a real display name and avatar once hydrated.
- 07fc404: Resolve two Mastodon read-surface fidelity gaps for locally-held targets. The actor DO gains `#resolveLocalObject` (pure SQL over its owner outbox then inbox, never an outbound fetch): a reply whose `inReplyTo` names a post the DO holds now carries that post's snowflake as `in_reply_to_id` plus its author as `in_reply_to_account_id` (the owner account when replying to the owner's own post), and a bare-IRI `Announce` of a locally-held post now hydrates its reblog with the real content and author instead of rendering content-less. Targets the DO does not hold still degrade to `null`/content-less as before — dereferencing a remote object is the remaining increment. New optional `BackendEntry.inReplyTo`/`BackendEntry.boost` fields carry the resolution through the adapter into `statusEntity`.
- 77d929a: Add an opt-in owner-scoped write surface to the Mastodon client API (`config.allowWrites`, default off). When enabled, `POST /api/v1/statuses` lets the single owner account author a status through a `write`-scoped bearer: the plain-text `status` is rendered to `Note` HTML (with `spoiler_text`/`sensitive` carried through), published via `@dwk/activitypub`'s existing outbox/fan-out path over a new internal `__client/publish` DO route, and returned as the owner-attributed `Status`. This deliberately widens the documented plain-bearer DPoP-everywhere exception from read-only to owner-scoped write — but only when opted in; the default keeps every write route `404`, so the exception stays strictly read-only. Enforcement: owner account required (`422` for app-level tokens), `write`/`write:statuses` scope required (`403` otherwise), 500-char ceiling. New seam `MastodonBackend.publishStatus?` and `tokenHasScope` helper. Delete, interaction verbs, follow, and reply-on-create are follow-up increments.

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
- Updated dependencies [20c4e9e]
- Updated dependencies [dc59912]
- Updated dependencies [07fc404]
- Updated dependencies [77d929a]
- Updated dependencies [4cd36af]
  - @dwk/mastodon-api@0.1.0-beta.1
  - @dwk/calendar@0.1.0-beta.3
  - @dwk/http-signatures@0.1.0-beta.4
  - @dwk/ldn@0.1.0-beta.4
  - @dwk/log@0.1.0-beta.5
  - @dwk/mcp@0.1.0-beta.1
  - @dwk/safe-fetch@0.1.0-beta.4
  - @dwk/webfinger@0.1.0-beta.5

## 0.1.0-beta.5

### Minor Changes

- d7f90d8: `@dwk/activitypub`'s inbox now verifies RFC 9421 (`Signature`/`Signature-Input`)
  HTTP Message Signatures in addition to the legacy draft-cavage profile, auto-detected
  per request. Delegates the RFC 9421 wire format and crypto to `@dwk/http-signatures`
  (now a real dependency, per issue #59) while keeping the existing draft-cavage
  path — and its exact `VerifyFailureReason` vocabulary — unchanged, so no caller
  needs to change. Traced from a live conformance run against Fedify (issue #273):
  Fedify signs `Follow` with draft-cavage but `Create`/other activities with RFC
  9421, so a target that only understood draft-cavage rejected those deliveries
  as `missing_signature`.
- 2870b43: Typed post objects + shaped publish endpoint (fediverse interop phase 1, #274).

  - New `objects.ts`: the canonical `PostInput` shape (`note` / `article` /
    `page`, media attachments with alt text, `sensitive`, blurhash, `to`/`cc`
    overrides) and pure builders producing correctly-addressed AS2
    `Note`/`Article`/`Page` objects — the content shapes Pixelfed (media notes)
    and Lemmy (titled `Page`s) render.
  - New owner-gated `POST <actor>/publish` endpoint accepting a bare `PostInput`
    body (same `publishToken` gate as the outbox seam); `POST <actor>/outbox`
    stays purely AS2.
  - Inbound activities are now stored with nullable `object_type` / `audience`
    classification columns (annotation only — the liberal store-and-ignore
    behavior for unknown shapes is unchanged).
  - Follower rows now record the remote instance's `sharedInbox` alongside the
    delivery inbox, enabling future per-instance fan-out batching.

- 96cc2d3: FEP-1b12 group participation (fediverse interop phase 2, #275) and the
  WebFinger client half (#277).

  `@dwk/webfinger` gains `lookup.ts` — the pure client half of RFC 7033:
  `parseHandle` (bare / `@user@host` / `!community@host` / `acct:` forms),
  `webfingerQueryUrl`, `selectActorLink`, and `resolveHandle` with an injected
  `fetch` (the package still makes no network calls of its own).

  `@dwk/activitypub` participates in FEP-1b12 communities:

  - **Follow-target typing (§2.1):** `following` rows record `actor_type`,
    `inbox`, and `shared_inbox`, resolved from the actor document off the
    critical path; pre-existing rows are lazily backfilled by the alarm tick
    (permanent failures mark `Unknown`), so old Group follows qualify without
    re-following. Owner-published `Follow` / `Undo(Follow)` now record the
    relationship and deliver to the target actor instead of fanning out.
  - **Announce unwrapping (§2.2):** an `Announce` from a followed `Group`
    wrapping a member activity stores the inner activity attributed to its real
    author — deduped by inner id, tagged `relayed_by` + group `audience`.
  - **Async two-tier origin verification, on by default (§2.2):** relayed
    content (`Create`/`Update`/`Delete`) verifies against its origin on the
    next alarm tick; votes (`Like`/`Dislike`) verify in batched sweeps.
    `verify_state` tracks `pending → verified`; a refuted row is deleted.
    Config: `verifyRelayedObjects: "tiered" (default) | "immediate" | "off"`.
  - **Community posting (§2.3):** a shaped post with an `audience` Group is
    additionally delivered to the group's inbox (resolved from the alarm when
    unknown); the group announces it to members per FEP-1b12.
  - **Community discovery (§2.4):** a handle-shaped `audience`
    (`!birding@lemmy.ml`) on `POST <actor>/publish` resolves to its Group actor
    IRI at the stateless front door via the `@dwk/webfinger` helper behind the
    SSRF guard.
  - **`Dislike`** accepted inbound (stored like `Like`) and publishable
    outbound (with `Undo`).

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

- 90f1bc6: Phase 2 of the Mastodon-compatible client API (#349): the DO-backed read
  surface. `@dwk/activitypub` gains additive internal routes
  (`__client/timeline`, `__client/notifications`, `__client/entry`, extended
  `__stats`) and one new export, `createActivitypubMastodonApi`, composing
  `@dwk/mastodon-api`'s router over them (mirrors the `createSolidPodWebdav`
  precedent). `@dwk/mastodon-api` gains `GET /api/v1/timelines/home`, `GET
/api/v1/notifications`, `GET /api/v1/statuses/:id`, `GET
/api/v1/accounts/:id`, Mastodon-shaped snowflake IDs, RFC 8288 `Link`
  pagination, an allowlist HTML sanitizer for inbound status content, and the
  AS2 → Mastodon entity mapping (including FEP-1b12 reblog provenance for
  group-relayed posts). Remote account ids are a reversible encoding of the
  actor IRI, so `accounts/:id` resolves them with no backend call and no
  outbound fetch. Follow notifications are deferred to phase 3 (#350) —
  inbound `Follow` activities aren't currently stored in a form this read
  surface can classify; see the phase-2 implementation notes for why.
- 1c179ac: Hydrate remote Mastodon client accounts from an alarm-driven ActivityPub actor
  cache, include the owner's outbox posts in the home timeline, and expose
  stored reply, favourite, and reblog counts on statuses. Outbox timeline IDs
  use the snowflake source bit, preserving existing inbox IDs and marker
  positions.
- 3a60a5c: Add `createActivitypubMcpTools` (#262): a `@dwk/mcp` tool contribution
  exposing the read-only `activitypub_list_inbox`, listing this actor's
  received activities newest-first. The public `/inbox` route stays
  write-only to peers (ActivityPub §7.1), so this reads through a new
  internal-only Durable Object route (`__inbox`, parallel to the existing
  `__stats`/`__resolve`/`__deliver` routes) rather than reusing any existing
  HTTP surface. `forwardedConfig` is now exported from `handler.ts` so the
  tool factory can build the same internal request shape the front door
  sends, without duplicating it.

### Patch Changes

- e6fee8e: Consolidate the outbound-delivery SSRF guard onto `@dwk/safe-fetch`'s
  `assertPublicUrl` instead of a second, hand-rolled IPv4/IPv6 check, closing a
  bypass where a mapped, 6to4, or Teredo IPv6 address (e.g. `[::ffff:127.0.0.1]`)
  was not recognized as private. The Durable Object's `#resolveInbox` and
  `#processVerifications` fetches now route through `safeFetch` as well, so a
  redirect on an already-validated target is re-validated hop by hop instead of
  trusting the initial check alone.
- a722a2e: Give alarm-driven delivery outcomes `Metrics` counter parity with their log
  lines (issue #336). The Durable Object cannot call the injected `Metrics`
  seam across the isolate boundary, and — unlike logging, where `console` is a
  direct `wrangler tail`-visible escape hatch — there is no direct-to-metrics
  equivalent. `activitypub.delivery.succeeded` / `.failed` / `.blocked` counter
  deltas now accumulate durably in the DO's SQLite (coalesced by
  `(event, fields)`, cardinality-capped with an explicit
  `activitypub.metrics.overflow` counter) and are drained to the front door on
  the next forwarded request via an internal `x-ap-metrics` response header;
  the front door replays them into the injected `Metrics` and strips the
  header. Drains are opt-in per request (`x-ap-metrics-drain`) so internal
  callers that would not relay the header never consume deltas, and are
  bounded per response so a backlog spreads across requests instead of
  bursting.
- 8e5ac84: Emit `activitypub.delivery.*` log events for alarm-driven outbound delivery
  (and pending-accept inbox resolution) directly via `console.log`/
  `console.error`, visible in `wrangler tail`. Previously these events were
  defined in the log vocabulary but never emitted anywhere — an alarm-driven
  delivery attempt has no HTTP response to hang the front door's
  `x-ap-outcome` header off, so success, retryable failure, permanent failure,
  and SSRF-blocked targets were completely unobservable in production. Each
  line reports the target host, HTTP status, attempt count, and whether the
  row was dropped — never activity bodies, keys, or tokens.
- 3e505be: `#ensureColumn`'s migration-detection now checks `PRAGMA table_info` instead
  of swallowing an `ALTER TABLE` error by matching `"duplicate column"` in its
  message, matching `@dwk/store`'s existing pattern. The substring match was
  fragile — a driver or SQLite version that phrases the error differently would
  have silently swallowed a real failure instead of surfacing it.
- 36a3be1: Gate the owner-only internal Durable Object routes (`__inbox`, `__following`)
  behind an explicit internal marker header (#310). These routes have no public
  front-door equivalent, but the DO served them on path match to any request
  carrying the front-door config header — so a future front-door route that
  forwarded such a path could expose the owner's inbox. The trusted callers (the
  `@dwk/mcp` tool and the community-syndication provider) now set an
  `x-ap-internal` marker, and the DO refuses those routes with `404` without it —
  defense in depth, mirroring `@dwk/solid-pod`'s internal-route markers.
- 0e65ce3: Cap the number of batches scanned per client-list page — both the outbox
  owner-post merge into a Mastodon timeline and the inbox notifications scan —
  so a like/announce-dominated outbox or a plain-post-dominated inbox can no
  longer force a near-full-table scan per request. Also de-duplicate the
  cancellable timeout-signal helper: `@dwk/safe-fetch` now exports
  `createTimeoutSignal`, reused by `@dwk/activitypub` and `@dwk/webfinger`
  instead of each carrying its own copy.
- 35830e6: Fix: an owner-published `Like`/`Dislike` sent via `POST <actor>/outbox` (a
  Lemmy vote) only ever reached the actor's own followers — it never reached
  the community or post being voted on, since a vote's `object` names content,
  not an actor, so there was no inbox to route to the way `Follow`'s `object`
  (an actor) already gets single-target delivery. The raw outbox now also
  delivers to a named `audience` Group's inbox, the same mechanism community
  posts (`POST <actor>/publish`) already use. A vote must set `audience` to
  reach the community; without it, delivery is unchanged (followers only).
- bde0341: Close two critical identity-binding gaps found in the pre-1.0 code review, both
  on unauthenticated / attacker-controlled paths:

  - **`@dwk/activitypub`: actor impersonation via the default key resolver
    (#287, #288).** Inbound HTTP-signature verification trusted the `owner`
    field of whatever document the attacker-supplied `keyId` served, so a key
    document hosted at `https://evil.example/key` could declare
    `owner: https://victim.example/users/alice` and have signed activities
    attributed to the victim. The default resolver now binds the resolved
    `owner` to the origin that **actually served** the key — the final URL after
    any redirects, not the requested `keyId`, so an open redirect on the
    requested origin cannot smuggle attacker-served content in under it — and the
    `keyId` fetch runs through `@dwk/safe-fetch`'s
    `safeFetch` — `https:`-only, with private/loopback/link-local hosts blocked
    and **every redirect hop re-validated** (so a public host cannot `302` the
    fetch onto an internal address), plaintext `http:` no longer accepted, and a
    bounded, size-capped body read — instead of an unguarded `fetch`.

  - **`@dwk/vc`: credential forgery via unbound `verificationMethod` (#289).**
    Proof verification never tied the proof's `verificationMethod` to the
    credential's `issuer`, so a credential naming any `issuer` could be signed
    with an attacker's own key and still verify. `verifySingleProof` now
    requires the verification method's controller (its declared `controller`,
    or the DID/URL portion of the method id) to equal the credential's issuer
    before the key is trusted. A new optional `expectedController` on
    `VerifyProofOptions` allows overriding the bound party for non-issuance
    proof purposes (e.g. a presentation's `authentication` proof).

- Updated dependencies [0e65ce3]
- Updated dependencies [d7f90d8]
- Updated dependencies [36a3be1]
- Updated dependencies [96cc2d3]
- Updated dependencies [bde0341]
- Updated dependencies [3e505be]
- Updated dependencies [3e505be]
- Updated dependencies [7b4349c]
- Updated dependencies [90f1bc6]
- Updated dependencies [1c179ac]
- Updated dependencies [36a3be1]
- Updated dependencies [39f6d61]
- Updated dependencies [3e505be]
  - @dwk/safe-fetch@0.1.0-beta.3
  - @dwk/webfinger@0.1.0-beta.4
  - @dwk/http-signatures@0.1.0-beta.3
  - @dwk/calendar@0.1.0-beta.2
  - @dwk/log@0.1.0-beta.4
  - @dwk/mastodon-api@0.1.0-beta.0
  - @dwk/ldn@0.1.0-beta.3

## 0.1.0-beta.4

### Minor Changes

- 65264d2: Federate calendar events and RSVPs over ActivityPub (the Fediverse layer of the
  calendar/events epic, #171). Add `calendarEventToActivityStreams`, the
  `CalendarEvent → ActivityStreams 2.0 Event` adapter that reads the canonical
  `@dwk/calendar` model so an `h-event`, a `VEVENT`, and an AS2 `Event` are three
  serializations of one record; the owner publishes it through the existing
  outbox seam. The inbox now handles `Join`/`Leave` — the ActivityPub mirror of an
  Indie RSVP — recording participation as authoritative Durable Object state for
  events this actor owns, auto-`Accept`ing a `Join` (signed `Accept` to the
  participant's inbox) unless the new `manuallyApprovesJoins` config holds it
  `pending`.

### Patch Changes

- 7b86416: Reject `.onion` inboxes in the outbound-delivery SSRF guard
  (`assertPublicHttpsTarget`). Workers cannot reach Tor onion services (RFC 7686
  keeps `.onion` out of public DNS), so such targets are now dropped
  non-retryably as `blocked_host` instead of failing at the network layer.
- 1d13d8a: Auto-`Accept`-on-`Follow`/`Join` no longer resolves the remote actor's inbox
  inline while handling the inbound POST. Resolving a remote actor document is
  an outbound fetch bounded by a 10s timeout; running it inline held the
  single-threaded Durable Object's input gate open for the duration, stalling
  every other request to that actor (including unrelated inbox deliveries and
  the sending server's own POST). Resolution is now queued and resolved from
  the alarm-driven delivery pass, alongside ordinary delivery retries.
- 18a5310: Harden two unauthenticated/attacker-controlled fetch paths found in a
  Cloudflare Workers best-practices review:

  - `@dwk/activitypub`: the inbox and owner-publish endpoints now cap the
    request body (2 MB) before buffering it, rejecting oversized bodies with
    413 instead of letting an unauthenticated federation peer control how much
    memory the Worker allocates.
  - `@dwk/vc`: verifying a foreign `credentialStatus.statusListCredential` URL
    (attacker-controlled, taken from the credential under verification) now
    goes through an SSRF-safe fetch — https-only, private/reserved hosts
    blocked (previously only the scheme was checked), a bounded timeout, and a
    capped response body read — instead of an unguarded `fetch`.

- Updated dependencies [fc4f47b]
- Updated dependencies [6d14fc3]
  - @dwk/calendar@0.1.0-beta.1
  - @dwk/log@0.1.0-beta.3

## 0.1.0-beta.3

### Minor Changes

- c63d205: Mastodon 4.6 federation updates. The actor document now carries the FEP-2c59
  `webfinger` back-link — its canonical `acct:<username>@<domain>` handle, the
  domain defaulting to the actor-URL host and overridable via the new `acctDomain`
  config — so a peer can validate the handle ↔ actor mapping without a reverse
  lookup. When the owner sets them, the actor also federates the Mastodon 4.6
  profile-preference flags `showFeatured` / `showMedia` / `showRepliesInMedia`
  (toot namespace) via new `ActorProfile` fields; unset flags are omitted. On the
  inbox, a temporary signature-verification failure (the signer's key could not be
  resolved, e.g. their server was briefly unreachable) now answers `503` +
  `Retry-After` so the peer redelivers, rather than `401` which permanently drops
  the activity; cryptographic/format failures still return `401`.

## 0.1.0-beta.2

### Patch Changes

- Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.2`). No public API changes.
- Updated dependencies
  - @dwk/ldn@0.1.0-beta.2
  - @dwk/log@0.1.0-beta.2

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/ldn@0.1.0-beta.1
  - @dwk/log@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

- 1fd8857: Add `@dwk/activitypub` — a native ActivityPub actor rooted at the user's own
  domain. The second `@dwk` package to ship a Durable Object, mirroring the
  `@dwk/solid-pod` architecture: a stateless front door over a per-actor DO that
  is the consistency authority for dedup, collections, and the delivery queue.
  - **`createActivityPub(config)`** returns the standard
    `(request, env, ctx) => Promise<Response>` handler and the package exports the
    `ActivityPubObject` Durable Object class. The actor profile, key material, and
    delivery policy are config-supplied — never read from the global environment —
    and the handler fails loudly when the `ACTOR` Durable Object binding is
    missing.
  - **Actor + collections:** the `Person` actor document (public key inline) plus
    `outbox` / `followers` / `following` as paged `OrderedCollection`s; the inbox
    is write-only to peers.
  - **Server-to-server federation:** inbound `POST /inbox` with edge HTTP-signature
    verification, activity-`id` dedup, and handling of `Follow` / `Undo` /
    `Accept` / `Create` / `Update` / `Like` / `Announce` / `Delete`; outbound
    auto-`Accept` of follows and signed fan-out delivery to follower inboxes with
    retry/backoff via DO alarms.
  - **HTTP Message Signatures** (`draft-cavage`, RSA-SHA256, body integrity via
    `Digest`) are implemented inline against an RSA-only algorithm allow-list and
    sit behind the `verifyInboxSignature` seam, so the forthcoming cross-standard
    `@dwk/http-signatures` package (#59) can be swapped in unchanged.
  - **Delivery safety:** every target passes a syntactic SSRF guard (HTTPS only;
    private/loopback/link-local/metadata hosts refused) before any request leaves.
  - **NodeInfo** discovery + a mostly-static `nodeinfo/2.1` document (live `usage`
    counts from the DO), and an owner-only, bearer-gated publish endpoint
    (`POST <actor>/outbox`) as the `@dwk/micropub` publish → `Create` fan-out seam.
    Full client-to-server authoring is out of scope for v1.

- 6011241: Spec-compliance follow-ups (#93): advertise and serve an instance-level shared
  inbox at `${baseUrl}/inbox` via `endpoints.sharedInbox` (ActivityPub §4.1 /
  §7.1.3, enabled by default, toggle with the new `sharedInbox` config flag);
  content-negotiate the actor document to the
  `application/ld+json; profile="…activitystreams"` variant when a strict client
  asks for it (§3.2, via the new `as2ContentType` helper); advertise both the
  NodeInfo `schema/2.0` and `schema/2.1` documents and serve `/nodeinfo/2.0`
  (new `buildNodeInfo20`); and reject an inbound `Create`/`Update` whose embedded
  object is `attributedTo` an actor other than the verified signer (§3 SHOULD).
- 7cb9c05: Add `@dwk/ldn` — RDF-only, protocol-agnostic Linked Data Notifications (W3C LDN)
  primitives, and wire `@dwk/solid-pod` and `@dwk/activitypub` to consume them
  (resolves the "extract / leave / close" decision in #63 as **extract**).
  - **`@dwk/ldn`** implements the three LDN roles as plain-data functions over
    `@dwk/rdf`'s flat `StoredQuad` representation, with no Cloudflare bindings, no
    transport, and no Solid/WAC assumptions: **discovery** (`inboxLinkHeader` /
    `inboxTriple` to advertise, `parseInboxLinks` / `discoverInboxIris` to find an
    inbox), **receiver** (`parseNotification` validates a posted RDF notification,
    throwing a `NotificationProblem` carrying the HTTP status — `415` for a non-RDF
    media type, `400` for an unparseable/empty body), and **consumer**
    (`inboxListingQuads` / `listInboxMembers` for the `ldp:Container` +
    `ldp:contains` listing). The discovery helpers depend on `@dwk/rdf` for types
    only, so they are reachable as the n3-free entry point `@dwk/ldn/discovery`
    that a Workers-runtime consumer imports without pulling in the RDF parser.
  - **`@dwk/solid-pod`** now surfaces any `ldp:inbox` a resource's graph declares
    as a `Link rel="http://www.w3.org/ns/ldp#inbox"` header on `GET`/`HEAD`,
    implementing LDN discovery on top of its existing LDP container receiver.
  - **`@dwk/activitypub`** advertises the actor's inbox via the same LDN `Link`
    header on the actor document, so a plain LDN sender can discover it without
    parsing the ActivityStreams body.

### Patch Changes

- 44e82b5: Fix three ActivityPub conformance gaps. Implement §7.1.2 inbox forwarding so a
  received activity addressed to our `followers` collection that references a
  locally-owned object (`object`/`target`/`inReplyTo`/`tag`) is re-delivered
  verbatim to followers the first time it is seen — closing the "ghost replies"
  interop hole where replies to a local post never reached the local actor's
  other followers. Handle inbound `Reject` of a `Follow` we sent by removing the
  stuck `following` row (previously it fell through and was ignored). Always mint
  the activity `id` server-side for owner-published outbox activities, ignoring a
  client-supplied `id` as required by §6/§3.1.
- ac90fce: Tidy package metadata for cross-package consistency.
  - **`@dwk/microsub`:** exclude `src/test-harness.ts` from the published `files`
    array so the Miniflare test harness no longer ships in the tarball, matching
    every other Durable-Object/`workerd` package.
  - **`keywords`:** backfill an npm `keywords` array on the packages that lacked
    one, so all published packages carry discovery keywords in the same style.
  - **`index.ts` doc comments:** normalize the spec pointer to the
    `@see spec/packages/<name>.md` tag (instead of prose or a missing pointer) on
    the libs whose headers had drifted, per the repo convention.

- 88dfd8e: Parse the HTTP Signature `keyId` with the WHATWG `URL` object instead of
  splitting on `#`. The default key resolver now strips the IRI fragment per the
  URL spec and rejects an unparseable `keyId` before issuing a network fetch,
  rather than reproducing fragment-stripping with string surgery. It also
  restricts the `keyId` to `http(s)` schemes, so a crafted `data:`/`file:` IRI
  cannot smuggle an attacker-chosen key past signature verification on runtimes
  whose `fetch` dereferences such URIs.
- Updated dependencies [78f1a6f]
- Updated dependencies [7cb9c05]
- Updated dependencies [bf285a1]
- Updated dependencies [6963674]
- Updated dependencies [ac90fce]
  - @dwk/log@0.1.0-beta.0
  - @dwk/ldn@0.1.0-beta.0
