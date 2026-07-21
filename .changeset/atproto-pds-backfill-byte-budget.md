---
"@dwk/atproto-pds": patch
---

The `subscribeRepos` `?cursor=` backfill replay now enforces a 16 MiB total
byte budget, closing the connection with a `BackfillOverflow` error frame if
exceeded, instead of queuing an unbounded burst (up to ~1 GiB in the worst
case) onto the socket with no flow control. Workers' `WebSocket` exposes no
`bufferedAmount` to gate on, and the replay must stay synchronous (no
`await`) to preserve its no-concurrent-commit-interleaving guarantee, so the
fix bounds the total instead of waiting for the client to drain.
