---
"@dwk/activitypub": patch
---

Enforce `readBodyCapped` at the two remaining unbounded remote-fetch sites in
`object.ts` (`#processVerifications`, `#resolveInbox`), matching the capped
read discipline the rest of the file already follows. Both parsed a remote
actor/verification document via `response.json()` directly, which buffers the
full body regardless of a lying or missing `Content-Length`; they now read
through `readBodyCapped(response, ACTOR_PROFILE_MAX_BODY_BYTES)` before
`JSON.parse`, so an oversized body is rejected up front instead of buffered.
