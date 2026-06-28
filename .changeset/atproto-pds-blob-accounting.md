---
"@dwk/atproto-pds": minor
---

Add blob accounting for migration — part of #183 (account migration).

A migration transfers blobs client-side (read the source's blobs, write them
here via `uploadBlob`); the server's job is to enumerate what it holds and what
records still reference but lack, so the client knows when the move is complete:

- **`com.atproto.sync.listBlobs`** — the CIDs of blobs this account holds
  (validates the required `did`).
- **`com.atproto.repo.listMissingBlobs`** — blobs referenced by the record set
  but not yet uploaded (authenticated).
- **`extractBlobCids`** (in `record.ts`) — walk a record's DAG-CBOR for
  `{ $type: "blob", ref: <CID> }` references.
- `com.atproto.server.checkAccountStatus` now reports real `expectedBlobs` /
  `importedBlobs` counts (referenced vs held).

PLC key rotation is the remaining migration increment.
