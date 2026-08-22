---
"@dwk/indieauth": patch
---

Use `crypto.subtle.timingSafeEqual` for PKCE and HMAC signature comparison
instead of a hand-rolled loop that short-circuited (and leaked timing) on a
length mismatch.
