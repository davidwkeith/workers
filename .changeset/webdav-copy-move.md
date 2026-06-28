---
"@dwk/solid-pod": minor
"@dwk/webdav": minor
---

Implement WebDAV **`COPY`/`MOVE`** on the pod's "second door" (#169) — the
drag-drop and rename verbs OS file managers use — replacing the prior `501`.

- `@dwk/webdav`: the router now `404`s a `COPY`/`MOVE` of a missing source and
  `409`s copying/moving a collection into its own subtree (RFC 4918 §9.8.5 /
  §9.9.4), ahead of the existing `Destination`/`Overwrite`/`Depth`/lock checks.
- `@dwk/solid-pod`: the in-DO backend implements `copy`/`move` over `@dwk/store`.
  A data resource is copied verbatim — the content-addressed R2 blob makes a copy
  a near-free pointer; a container is recreated fresh with its `ldp:contains`
  rebuilt as children copy in (so membership reflects the new tree, not the
  source). `Depth: 0` copies only the collection; `MOVE` is copy-then-drop-source
  and is always `Depth: infinity`. Overwrite is delete-then-copy so no stale
  destination subtree lingers, and the storage root is immovable (`405`), as it
  is undeletable.
