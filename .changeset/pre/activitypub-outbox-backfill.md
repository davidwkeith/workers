---
"@dwk/activitypub": minor
---

Add backfill support to the outbox Durable Object (#451): `?skipDelivery=1`
on `POST <actor>/outbox` and `POST <actor>/publish` inserts the activity into
the outbox without follower fan-out, relationship routing, community
delivery, or arming the delivery alarm, and a caller-supplied `published`
(ISO-8601) is preserved instead of always being stamped to `now`. The outbox
`OrderedCollection` now orders by `published_at` instead of insertion order,
so a backfilled post sorts into its historical position.
