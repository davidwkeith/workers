---
"@dwk/store": patch
---

Harden the blob GC resurrection guard against the timestamp race that could
delete a live, resurrected object (#33). Because blob keys are content-addressed,
a deleted key can be legitimately resurrected by a later `putBlob` of identical
content, and the old guard decided liveness purely by comparing R2's
second-resolution `uploaded` against the DO's `enqueued_at` — racy across the
`head`→`delete` window and across clock skew / sub-second deletes-then-recreates.

- `collectGarbage` is now **version-conditional**: it captures the object's R2
  `version` at `head` time and re-checks it immediately before deleting, so a
  resurrection landing in that window aborts the delete (R2 bindings have no
  atomic conditional delete; this head→delete recheck is the tightest guard
  available). The timestamp heuristic now requires `uploaded` to exceed
  `enqueued_at` by a configurable `clockSkewMs` margin (default 5s).
- `putBlob`'s resurrection guard now also cancels an **already-forwarded** GC
  row, not just the local outbox row: forwarded outbox rows are retained for a
  retention window and a resurrection records an "un-orphan" tombstone that
  `forwardOrphans` propagates to the shared store (cancels before inserts).
- The shared `orphan_blobs` D1 table dedups on a UNIQUE `blob_key`, keeping the
  **max** `enqueued_at`, so at-least-once forwarding and re-orphaning never
  shorten a key's safety window.
