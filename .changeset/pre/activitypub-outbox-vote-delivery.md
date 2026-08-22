---
"@dwk/activitypub": patch
---

Fix: an owner-published `Like`/`Dislike` sent via `POST <actor>/outbox` (a
Lemmy vote) only ever reached the actor's own followers — it never reached
the community or post being voted on, since a vote's `object` names content,
not an actor, so there was no inbox to route to the way `Follow`'s `object`
(an actor) already gets single-target delivery. The raw outbox now also
delivers to a named `audience` Group's inbox, the same mechanism community
posts (`POST <actor>/publish`) already use. A vote must set `audience` to
reach the community; without it, delivery is unchanged (followers only).
