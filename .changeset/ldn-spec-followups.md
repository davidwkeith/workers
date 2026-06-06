---
"@dwk/ldn": minor
---

LDN spec-compliance follow-ups for the receiver and discovery helpers:

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
