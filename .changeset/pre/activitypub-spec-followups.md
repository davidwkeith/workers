---
"@dwk/activitypub": minor
---

Spec-compliance follow-ups (#93): advertise and serve an instance-level shared
inbox at `${baseUrl}/inbox` via `endpoints.sharedInbox` (ActivityPub §4.1 /
§7.1.3, enabled by default, toggle with the new `sharedInbox` config flag);
content-negotiate the actor document to the
`application/ld+json; profile="…activitystreams"` variant when a strict client
asks for it (§3.2, via the new `as2ContentType` helper); advertise both the
NodeInfo `schema/2.0` and `schema/2.1` documents and serve `/nodeinfo/2.0`
(new `buildNodeInfo20`); and reject an inbound `Create`/`Update` whose embedded
object is `attributedTo` an actor other than the verified signer (§3 SHOULD).
