---
"@dwk/activitypub": minor
"@dwk/mastodon-api": minor
---

Implement `follow` notifications (the deferred phase-2 gap): `@dwk/activitypub`'s `#onFollow` now stores a _new_ follower's `Follow` (or FEP-1b12 `Group` membership `Join`) in the actor's inbox — a re-Follow from a still-recorded follower is not a fresh notification — and the `__client/notifications` classifier surfaces those rows; `@dwk/mastodon-api`'s `notificationEntity` maps them to Mastodon's `type: "follow"` (account attached, `status: null`), so clients like Tusky and Pixelfed now see new-follower notifications. Storing via the existing inbox path also queues the follower's actor-profile fetch, so the notification renders with a real display name and avatar once hydrated.
