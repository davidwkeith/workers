---
"@dwk/indieauth": patch
---

`authorization_codes` and `access_tokens` are now opportunistically reaped of
expired rows on every new authorization-code save / token issuance, since
this package has no cron entrypoint of its own to schedule the cleanup.
Previously neither table was ever pruned, so both grew unbounded over a
deployment's lifetime and slowed `isTokenActive`'s scan. Both tables now also
have a supporting index on `expires_at`, so the new per-write prune is an
index-range delete rather than a full-table scan on every save/issuance.
