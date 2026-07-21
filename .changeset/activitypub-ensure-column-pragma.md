---
"@dwk/activitypub": patch
---

`#ensureColumn`'s migration-detection now checks `PRAGMA table_info` instead
of swallowing an `ALTER TABLE` error by matching `"duplicate column"` in its
message, matching `@dwk/store`'s existing pattern. The substring match was
fragile — a driver or SQLite version that phrases the error differently would
have silently swallowed a real failure instead of surfacing it.
