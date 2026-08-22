---
"@dwk/ldn": minor
"@dwk/solid-pod": minor
"@dwk/activitypub": minor
---

Add `@dwk/ldn` — RDF-only, protocol-agnostic Linked Data Notifications (W3C LDN)
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
