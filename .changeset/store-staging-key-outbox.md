---
"@dwk/store": patch
---

Streamed blob writes now enroll their transient staging key in the same
transactional orphan outbox ordinary resource deletes use, from the moment the
key is created. Previously an isolate evicted mid-write (OOM/wall-clock) could
leak the staging object in R2 forever, since cleanup only ran in a `finally`
block; a leaked staging key is now forwarded and reclaimed by the existing cron
GC after its safety window, same as any other orphan.
