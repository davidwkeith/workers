---
"@dwk/activitypub": minor
---

Host FEP-1b12 `Group` actors — the producer side of a fediverse community
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
