---
"@dwk/activitypub": patch
---

Auto-`Accept`-on-`Follow`/`Join` no longer resolves the remote actor's inbox
inline while handling the inbound POST. Resolving a remote actor document is
an outbound fetch bounded by a 10s timeout; running it inline held the
single-threaded Durable Object's input gate open for the duration, stalling
every other request to that actor (including unrelated inbox deliveries and
the sending server's own POST). Resolution is now queued and resolved from
the alarm-driven delivery pass, alongside ordinary delivery retries.
