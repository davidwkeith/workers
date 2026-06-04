# `@dwk/store`

> DO-SQLite quad store + R2 copy-on-write blob bodies behind one storage interface.

Part of the [`@dwk` IndieWeb + Solid cohort](../../README.md). See the
[package specification](../../spec/packages/store.md) for the full requirements.

Runs **inside** the `@dwk/solid-pod` Durable Object and confines all Cloudflare
storage specifics, so the endpoint packages stay storage-agnostic and
unit-testable. Authoritative state lives only in DO SQLite and R2 — never KV.

## What it does

- **One interface, two backends.** RDF triples live in the DO's SQLite quad
  store; opaque bodies live in R2. `head`, `readQuads`, `writeQuads`,
  `patchQuads`, `putBlob`, `readBlob`, `putResource`, and `delete` hang off a
  single `Store`.
- **Transactional writes.** `writeQuads` / `patchQuads` apply an N3-Patch's
  `deletes`+`inserts` in one `transactionSync`, and the `If-Match` /
  `If-None-Match` preconditions are checked and applied inside the same
  transaction, so check-and-write is TOCTOU-free. `delete` accepts an optional
  in-transaction `guard` for the same reason (e.g. LDP container emptiness).
- **Copy-on-write blobs.** `putBlob` writes a new content-addressed R2 object,
  then atomically flips the DO pointer and outboxes any now-unreferenced
  predecessor key. Reads are streamed straight from R2 — never buffered.
- **Size-threshold routing.** `putResource` keeps small RDF in the quad store
  and offloads anything over the ~2 MB DO-cell ceiling to R2 as an opaque blob.
- **Sweep-free GC.** Deletes drop the pointer first and record the orphaned key
  to a transactional outbox in the same SQLite transaction. `forwardOrphans`
  drains the outbox into a shared D1 tracking store, and `collectGarbage`
  reclaims R2 objects after a safety window using **only D1 and R2** — it never
  scans or wakes a per-pod Durable Object.
- **Resurrection-safe reclaim.** Because keys are content-addressed, a deleted
  key can be revived by a later `putBlob` of identical content. `collectGarbage`
  deletes version-conditionally (re-checking the R2 `version` between `head` and
  `delete`) and `putBlob` cancels an already-forwarded GC row, so GC never
  reclaims an object a live resource points at.

```ts
import { createStore } from "@dwk/store";

// Inside the solid-pod Durable Object:
const store = createStore(state, env);
const etag = await store.putBlob("/photo.jpg", bytes, {
  contentType: "image/jpeg",
});
const body = await store.readBlob("/photo.jpg"); // { stream, etag, ... }
```

## License

[ISC](../../LICENSE)
