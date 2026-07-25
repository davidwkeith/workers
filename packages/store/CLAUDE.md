# @dwk/store

DO-SQLite quad store + R2 blob bodies — the storage confinement layer.

## What this is

Encapsulates all Cloudflare-specific storage behind a single `Store` interface.
Per-pod Durable Object with SQLite for quads/metadata and R2 for large blob
bodies. Implements transactional writes (N3 Patch deletes + inserts in one txn),
TOCTOU-free If-Match/ETag checks, content-addressed R2 deduplication, and an
orphan-outbox GC pattern for safe blob cleanup. Each resource pointer also
tracks byte size and last-modified time (`ResourceMeta.size` / `modifiedAt`,
refreshed on every write) so WebDAV PROPFIND can serve `getcontentlength` /
`getlastmodified`.

## Spec

`spec/packages/store.md` — authoritative requirements.

## Key constraints

- **Confinement layer.** This is where Cloudflare storage specifics live. Pure
  libs (`@dwk/rdf`, `@dwk/wac`) must never import from here.
- **Strong consistency only.** Authoritative state lives in DO SQLite (single-
  threaded) and R2. **Never use KV for anything where staleness is a
  correctness/security bug.**
- **Stream, never buffer.** R2 bodies stream through the Worker — never load a
  full blob into the DO's 128 MB memory.
- **Size-threshold routing.** Quads up to ~2 MB stay inline in SQLite; beyond
  that, they're offloaded to R2 as opaque bodies via copy-on-write.
- **ETag is opaque.** Per-resource ETag is a fresh opaque validator on every
  write, never a content hash, to prevent If-Match collisions.
- **GC pattern.** Delete: drop pointer first → enqueue orphan key → cron drains
  orphan table after safety window (≥ max write duration). The `collectGarbage`
  and `forwardOrphans` functions implement this; `d1OrphanSink` bridges to D1
  for cross-DO coordination.
