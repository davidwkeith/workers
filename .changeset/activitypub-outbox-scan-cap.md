---
"@dwk/activitypub": patch
"@dwk/safe-fetch": patch
"@dwk/webfinger": patch
---

Cap the number of batches scanned per client-list page — both the outbox
owner-post merge into a Mastodon timeline and the inbox notifications scan —
so a like/announce-dominated outbox or a plain-post-dominated inbox can no
longer force a near-full-table scan per request. Also de-duplicate the
cancellable timeout-signal helper: `@dwk/safe-fetch` now exports
`createTimeoutSignal`, reused by `@dwk/activitypub` and `@dwk/webfinger`
instead of each carrying its own copy.
