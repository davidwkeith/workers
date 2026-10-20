---
"@dwk/activitypub": minor
---

Add `actor.alsoKnownAs` so an `@dwk/activitypub` actor can be the target of a Mastodon account migration (`Move`): set it to the origin account's actor IRI and the actor document federates it as `alsoKnownAs`, which Mastodon's move flow and followers' servers require before honoring the move.
