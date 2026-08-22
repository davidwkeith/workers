---
"@dwk/activitypub": minor
---

Give an actor's owner a way to remove and block a follower (#447). Previously
the owner-publish path special-cased only `Follow` and `Undo(Follow)`, both of
which operate on `following`; an owner-published `Reject` or `Block` was fanned
out to the entire follower set and left the target's `followers` row in place,
so the only remedy against an abusive follower was rotating the actor identity.

- **Follower-control activities** — `Reject` (of a `Follow`), `Block`, and
  `Undo(Block)` published to `POST <actor>/outbox` — are routed to the named
  actor's inbox alone through the same targeted queue an owner `Follow` uses,
  and are never written to the publicly-served outbox (an outbox row would
  publish the owner's moderation decisions). They answer `202` with the
  normalized activity.
- **`Reject`** drops the `followers` row and delivers a canonical
  `Reject(Follow)` naming the original `Follow`'s IRI when one was recorded.
  The target may be given as the embedded `Follow`, the follower's actor IRI,
  or the recorded `Follow`'s IRI.
- **`Block`** additionally persists a durable blocklist entry and severs both
  the `followers` and `following` rows. Every subsequent inbound activity from
  a blocked actor is refused with `403`, before dedup — not only a re-`Follow`.
  `Undo(Block)` reverses it and notifies the peer.
- **`?skipDelivery=1`** applies the local state change without federating it,
  for a silent removal.
- **`GET <actor>/blocked`** lists the blocklist behind the same bearer token as
  publishing, so a block can be reviewed and undone. It is never public.
