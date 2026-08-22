---
"@dwk/atproto-pds": minor
---

Add blob accounting for migration — part of #183 (account migration).

A migration transfers blobs client-side (read the source's blobs, write them
here via `uploadBlob`); the server's job is to enumerate what it holds and what
records still reference but lack, so the client knows when the move is complete:

- **`com.atproto.sync.listBlobs`** — the CIDs of blobs this account holds
  (validates the required `did`; paginated with `limit`/`cursor`).
- **`com.atproto.repo.listMissingBlobs`** — blobs referenced by the record set
  but not yet uploaded (authenticated; paginated with `limit`/`cursor`).
- **`extractBlobCids`** (in `record.ts`) — walk a record's DAG-CBOR for
  `{ $type: "blob", ref: <CID> }` references. Blob references are maintained in an
  indexed `record_blobs` table (updated on write/delete/import), so the
  referenced-blob set is a `SELECT DISTINCT` rather than a scan-and-decode of every
  record — keeping it within Worker CPU/DO memory limits for large repos.
- `com.atproto.server.checkAccountStatus` now reports real `expectedBlobs` /
  `importedBlobs` counts (referenced vs held).

PLC key rotation is the remaining migration increment.
