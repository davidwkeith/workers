---
"@dwk/activitypub": minor
---

Add `GET <actor>/follow_requests`, a bearer-gated equivalent of the
internal-marker-gated `__client/follow_requests` route `@dwk/mastodon-api`
uses, so an owner-facing client (e.g. a moderation UI) can list pending
followers without standing up a separate OAuth flow (#487).
