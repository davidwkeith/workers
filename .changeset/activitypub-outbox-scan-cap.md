---
"@dwk/activitypub": patch
"@dwk/safe-fetch": patch
"@dwk/webfinger": patch
---

Cap the number of outbox batches scanned when merging owner posts into a
Mastodon timeline page, so a like/announce-dominated outbox can no longer
force a near-full-table scan per request. Also de-duplicate the cancellable
timeout-signal helper: `@dwk/safe-fetch` now exports `createTimeoutSignal`,
reused by `@dwk/activitypub` and `@dwk/webfinger` instead of each carrying its
own copy.
