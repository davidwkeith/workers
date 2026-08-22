---
"@dwk/store": minor
"@dwk/solid-pod": patch
---

Track per-resource **byte size** and **last-modified time** in `@dwk/store` and
surface them on `ResourceMeta` (`size`, `modifiedAt`), so consumers get real
file metadata without an extra read (#169).

- `@dwk/store`: a `size` column is added to the `resources` table (with an
  idempotent migration for pods predating it) and recorded on every write — the
  blob write path measures the R2 object's byte size, and inline RDF records its
  source byte length via a new optional `WriteOptions.size`. `mtime` reuses the
  existing `updated_at`. `head()` and `list()` now return both. Size is `0` for
  resources with no canonical byte body (e.g. containers).
- `@dwk/solid-pod`: the WebDAV adapter drops its `getlastmodified` stand-in and
  its extra `readBlob`-for-size, reporting the store's real `size`/`modifiedAt`
  in PROPFIND/HEAD/GET. A stable, accurate `getlastmodified` no longer makes OS
  clients see a perpetually-changing file, and a `Depth: 1` listing is a pure
  SQLite scan with no per-child R2 round-trip.
