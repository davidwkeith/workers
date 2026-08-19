---
"@dwk/activitypub": minor
---

Store inbound `Flag` (report) activities instead of silently dropping
them, add a bearer-gated paginated `GET <actor>/reports` to list open
reports, and let the owner resolve one via `POST <actor>/outbox` with
`{ "type": "Ignore", "object": "<flag-id>" }` (#489).
