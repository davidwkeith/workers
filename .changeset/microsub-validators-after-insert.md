---
"@dwk/microsub": patch
---

Persist a feed's conditional-fetch validators only after its entries are stored
(#302). The poll consumer wrote the `ETag`/`Last-Modified` cache before
`insertItems`, so a transient insert failure (which retries the message) meant
the retry re-fetched with the already-updated validators, got a `304`, and
permanently dropped the entries it never stored. The cache is now written after
a successful insert (which dedups by entry id, so the re-insert on retry is
idempotent), and a `304` that omits validators keeps the previously-cached ones
instead of nulling them.
