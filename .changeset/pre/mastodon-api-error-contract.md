---
"@dwk/mastodon-api": patch
---

Wrap route dispatch in try/catch so a D1 failure or internal invariant throw
returns the documented Mastodon JSON error shape (`{"error": "..."}`,
via `mastodonError`) instead of an unhandled exception.
