---
"@dwk/microsub": patch
---

Send the poll-priming queue message in `follow` via `ctx.waitUntil` instead of
blocking the HTTP response on it.
