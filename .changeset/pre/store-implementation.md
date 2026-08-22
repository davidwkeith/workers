---
"@dwk/store": minor
---

Implement `@dwk/store`: a single storage interface over the DO-SQLite quad store
and R2 blob bodies, run inside the `@dwk/solid-pod` Durable Object.
Transactional quad reads/writes and N3-Patch `deletes`+`inserts` apply in one
`transactionSync`, with TOCTOU-free `If-Match` check-and-write. Blob bodies are
content-addressed and copy-on-write (write the new R2 object, then atomically
flip the DO pointer), streamed on read and never buffered. Size-threshold
routing keeps small RDF in SQLite and offloads bodies over the ~2 MB DO-cell
ceiling to R2. Deletes drop the pointer first and record orphaned keys to a
transactional outbox in the same SQLite transaction; `forwardOrphans` drains it
into a shared D1 tracking store and `collectGarbage` reclaims R2 objects after a
safety window using only D1 and R2 — never sweeping or waking a per-pod Durable
Object.
