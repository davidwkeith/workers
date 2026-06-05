---
"@dwk/activitypub": patch
---

Fix three ActivityPub conformance gaps. Implement §7.1.2 inbox forwarding so a
received activity addressed to our `followers` collection that references a
locally-owned object (`object`/`target`/`inReplyTo`/`tag`) is re-delivered
verbatim to followers the first time it is seen — closing the "ghost replies"
interop hole where replies to a local post never reached the local actor's
other followers. Handle inbound `Reject` of a `Follow` we sent by removing the
stuck `following` row (previously it fell through and was ignored). Always mint
the activity `id` server-side for owner-published outbox activities, ignoring a
client-supplied `id` as required by §6/§3.1.
