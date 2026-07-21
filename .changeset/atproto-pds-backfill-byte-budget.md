---
"@dwk/atproto-pds": patch
---

The `subscribeRepos` `?cursor=` backfill replay now enforces a 16 MiB total
byte budget, closing the connection with a `BackfillOverflow` error frame if
exceeded, instead of queuing an unbounded burst (up to ~1 GiB in the worst
case) onto the socket with no flow control. Workers' `WebSocket` exposes no
`bufferedAmount` to gate on, and the replay must stay synchronous (no
`await`) to preserve its no-concurrent-commit-interleaving guarantee, so the
fix bounds the total instead of waiting for the client to drain. The matching
rows are now iterated directly off the SQL cursor rather than `.toArray()`'d
up front, so the byte budget also gates further reads from SQLite (not just
sends to the socket) — the initial fix only bounded what reached the wire,
still risking the DO's memory budget while building the full row set.
