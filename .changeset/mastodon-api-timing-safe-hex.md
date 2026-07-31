---
"@dwk/mastodon-api": patch
---

Use `crypto.subtle.timingSafeEqual` for client-secret/token hex comparison
instead of a hand-rolled constant-time loop.
