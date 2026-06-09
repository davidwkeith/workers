# @dwk/ldn

## 0.1.0-beta.1

### Patch Changes

- 25d9cec: Coordinated beta iteration: roll all published packages to the next prerelease
  (`0.1.0-beta.1`). No public API changes.
- Updated dependencies [25d9cec]
  - @dwk/rdf@0.1.0-beta.1

## 0.1.0-beta.0

### Minor Changes

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

- bf285a1: LDN spec-compliance follow-ups for the receiver and discovery helpers:
  - `parseNotification` now **accepts** a well-formed RDF body that yields zero
    triples (an empty JSON-LD `@graph`, a bare `@context`, a Turtle document of
    only prefix declarations). LDN §3.2 does not require a notification to carry at
    least one triple, so this returns an empty `quads` array instead of throwing a
    `400 malformed`.
  - Add `acceptedContentTypes()` / `acceptPostHeader()` (LDN §3.3.1) so a receiver
    can build its `Accept-Post` advertisement from the same media-type table
    `parseNotification` validates against — the advertisement and the validator
    cannot drift.
  - Add `constrainedByLinkHeader(constraints)` and the `LDP_CONSTRAINED_BY` vocab
    term (LDN §5.1) so a receiver can advertise the constraints it imposes via an
    `ldp:constrainedBy` `Link` header.

### Patch Changes

- ac90fce: Tidy package metadata for cross-package consistency.
  - **`@dwk/microsub`:** exclude `src/test-harness.ts` from the published `files`
    array so the Miniflare test harness no longer ships in the tarball, matching
    every other Durable-Object/`workerd` package.
  - **`keywords`:** backfill an npm `keywords` array on the packages that lacked
    one, so all published packages carry discovery keywords in the same style.
  - **`index.ts` doc comments:** normalize the spec pointer to the
    `@see spec/packages/<name>.md` tag (instead of prose or a missing pointer) on
    the libs whose headers had drifted, per the repo convention.

- Updated dependencies [65cab2c]
- Updated dependencies [ac90fce]
- Updated dependencies [3a806d9]
- Updated dependencies [9224fd7]
  - @dwk/rdf@0.1.0-beta.0
