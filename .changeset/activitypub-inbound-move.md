---
"@dwk/activitypub": minor
---

Handle inbound `Move` (Mastodon account migration). When an account this actor follows announces a move, the actor follows the target and sends the old account an `Undo(Follow)`, but only after the target's `alsoKnownAs` is verified to list the old account. The target fetch runs from the alarm, off the inbound request path. New log events: `activitypub.move.followed` and `activitypub.move.rejected`.
