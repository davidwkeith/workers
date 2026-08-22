---
"@dwk/atproto-pds": minor
---

Ship the repository firehose — `com.atproto.sync.subscribeRepos` (#184), the last
of the four Cirrus-parity gaps (#180). The pure frame encoder had already landed;
this wires the live stream onto the per-account repository Durable Object.

- **Hibernatable WebSocket endpoint:** `subscribeRepos` is accepted via
  `ctx.acceptWebSocket`, so a subscription survives the DO evicting from memory
  and resumes delivery without the consumer reconnecting.
- **Per-commit broadcast:** every `createRecord` / `putRecord` / `deleteRecord`
  and a migration `importRepo` now emits a `#commit` event — a DAG-CBOR frame
  whose `blocks` CAR carries the signed commit block, the rebuilt MST nodes, and
  the changed records, so a Relay can apply the commit without a full `getRepo`.
- **Monotonic, persisted `seq`** in DO SQLite, so the stream is ordered and
  resumable across restarts.
- **`?cursor=` backfill:** a bounded ring of recent frames is replayed before the
  socket goes live; a cursor past the buffered window gets an `OutdatedCursor`
  info frame (then whatever remains), and a cursor ahead of the stream head gets
  a terminal `FutureCursor` error frame.
- New `encodeInfoFrame` / `encodeErrorFrame` encoders (`op: 1` `#info` and the
  `op: -1` error header) join the existing `#commit` framing on the public
  surface.
- **Write serialization:** the four commit-chain mutations (`createRecord`,
  `putRecord`, `deleteRecord`, `importRepo`) now run through a Durable Object
  write queue, so concurrent writes cannot interleave at `await` points and fork
  the linear commit chain (each used to read the same `prev` head). This upholds
  the package's single-writer invariant.
