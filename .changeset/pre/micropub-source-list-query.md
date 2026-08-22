---
"@dwk/micropub": minor
---

Add `q=source` list query extension: when no `url` parameter is provided, return
`{ items: [...] }` containing the authenticated caller's recent posts, ordered
newest-first by creation time. Supports offset-based pagination via `limit`
(default 10, max 100) and `offset` (default 0) parameters. Soft-deleted posts
are excluded. Property filtering via `properties[]` applies per-item, same as
single-post `q=source` queries.

Implements the widely-used Micropub post-list extension per
https://indieweb.org/Micropub-extensions#Query_for_Post_List. Required for
Anglesite iOS/Mac clients to browse draft posts for "resume editing" flows.
