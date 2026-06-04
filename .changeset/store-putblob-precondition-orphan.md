---
"@dwk/store": patch
---

Fix `putBlob` leaking an unreclaimable R2 orphan on a precondition failure
(#32). The content-addressed `put` happened unconditionally before the
transaction that evaluates `If-Match` / `If-None-Match`, so a failed
precondition left a freshly-written object that was never recorded to the
orphan outbox — and the full-sweep-free GC (which only reclaims keys reported
via the outbox) could never discover it.

`putBlob` now pre-checks the precondition against the current pointer before
writing to R2, so a deterministic failure rejects without landing an object.
The in-transaction check remains the TOCTOU-free authority; if a concurrent
write moves the pointer between the pre-check and the transaction, the
just-written key is recorded to the outbox (when no live resource references
it) before the error is re-thrown, so GC can still reclaim it.
