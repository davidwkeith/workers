---
"@dwk/webmention": patch
"@dwk/websub": patch
"@dwk/microsub": patch
---

Queue consumers now back off exponentially (30s base, doubling per attempt,
capped at 1h) when retrying a `message.retry()`, based on `message.attempts`.
Previously a bare `message.retry()` re-delivered at the queue's default
cadence indefinitely, hammering an unreachable source/feed/callback instead of
backing off.
