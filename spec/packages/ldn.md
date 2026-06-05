# `@dwk/ldn`

| | |
|---|---|
| **Type** | cross-standard reusable lib (RDF-only, protocol-agnostic) |
| **Ships a DO?** | no — pure plain-data functions, no Cloudflare bindings |
| **Standard** | [Linked Data Notifications](https://www.w3.org/TR/ldn/) |
| **Status** | implemented — extracted per [#63](https://github.com/davidwkeith/workers/issues/63) |

LDN defines a standard inbox: discovery via `ldp:inbox`, `POST` of an RDF
notification, and `GET` to list. The shared, protocol-agnostic pieces of that
contract are factored out here as plain-data functions over
[`@dwk/rdf`](rdf.md)'s flat `StoredQuad` representation, so the same primitives
back both the [`@dwk/solid-pod`](solid-pod.md) inbox and the
[`@dwk/activitypub`](activitypub.md) inbox without either standard leaking into
the other.

## Decision (resolved)

The three options in #63 were **extract** / **leave** / **close**. Resolved to
**extract**: the LDN-specific vocabulary, discovery, notification validation,
and listing are small, genuinely shared between Solid and ActivityPub, and were
not previously implemented as a distinct, reusable unit. Keeping them in
`@dwk/solid-pod` would have made them unreachable to `@dwk/activitypub` and would
have coupled them to WAC; a standalone lib keeps them RDF-only and reusable.

## What ships

- **Vocabulary** — the LDP/RDF term IRIs (`LDP_INBOX`, `LDP_CONTAINS`, …).
- **Discovery** — `inboxLinkHeader(inbox)` / `inboxTriple(subject, inbox)` to
  advertise an inbox, and `parseInboxLinks(header)` / `discoverInboxIris(quads,
  subject?)` to find one. The discovery module depends on `@dwk/rdf` for **types
  only** (erased at build), so it is reachable as the n3-free entry point
  `@dwk/ldn/discovery` that a Workers-runtime consumer imports without pulling in
  the RDF parser.
- **Receiver** — `parseNotification(body, contentType, { baseIRI })` validates a
  posted RDF notification, throwing a `NotificationProblem` carrying the HTTP
  status to answer (`415` non-RDF media type, `400` unparseable / no triples).
- **Consumer** — `inboxListingQuads(inbox, members)` and
  `listInboxMembers(quads, inbox?)` for the `ldp:Container` + `ldp:contains`
  listing.

## Consumers

- **`@dwk/solid-pod`** — on a resource read, surfaces any `ldp:inbox` the
  resource's graph declares as a `Link rel="http://www.w3.org/ns/ldp#inbox"`
  header (via `discoverInboxIris` + `inboxLinkHeader`), implementing LDN
  discovery on top of its existing LDP container receiver.
- **`@dwk/activitypub`** — advertises the actor's inbox via the same LDN `Link`
  header on the actor document, so a plain LDN sender can discover it without
  parsing the ActivityStreams body.

## Design constraints

- **RDF-only and protocol-agnostic** — it carries no Solid-specific WAC
  assumptions and no transport, so it backs both the Solid inbox and the
  ActivityPub inbox (composition-contract confinement). Authorization, dedup, and
  storage stay the caller's concern.

## Conformance / testing

- W3C LDN test suite. See
  [conformance-and-testing.md](../conformance-and-testing.md).
