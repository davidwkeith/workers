---
"@dwk/activitypub": minor
"@dwk/mastodon-api": minor
---

Add owner-admin endpoints: `Accept` (confirm a pending follower) and `Remove`
(ban a `Group` member / un-announce a post) via `POST <actor>/outbox`, and a
`@dwk/mastodon-api` `follow_requests` write surface (`GET`/`POST
.../authorize`/`POST .../reject`) so off-the-shelf Mastodon clients can manage
pending follows too.
