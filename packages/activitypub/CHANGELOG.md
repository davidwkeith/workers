# @dwk/activitypub

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
