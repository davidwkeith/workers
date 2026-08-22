---
"@dwk/atproto-pds": minor
---

Add the firehose frame encoder (`firehose.ts`) — increment 1 of #184, the last
Cirrus-parity gap.

Relays subscribe to `com.atproto.sync.subscribeRepos` to crawl a repository in
real time; without it, records written here are not discoverable by the network.
This lands the pure, Workers-runtime-free encoder for the event-stream frame
format (two concatenated DAG-CBOR objects: a `{ op: 1, t }` header + the body):

- **`encodeFrameHeader(t)`** — the message-frame header.
- **`encodeCommitBody(commit)` / `encodeCommitFrame(commit)`** — the `#commit`
  body (and full frame) with every lexicon-required field: `seq`, `repo`,
  `commit`, `rev`, `since`, `blocks` (CAR), `ops` (`create`/`update`/`delete`
  with `path` + nullable `cid`), `time`, the deprecated `rebase`/`tooBig`/`blobs`
  defaults, and optional `prevData`.

The Durable Object WebSocket endpoint — hibernatable accept, the persisted `seq`
cursor, per-commit broadcast, and `?cursor=` backfill — is the next increment.
