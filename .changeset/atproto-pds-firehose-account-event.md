---
"@dwk/atproto-pds": patch
---

Emit a firehose **`#account`** event on the migration activate/deactivate cutover.

`subscribeRepos` already streamed `#commit` events, but toggling the account's
hosting status (`com.atproto.server.activateAccount` /
`deactivateAccount`) only flipped local state — a subscribed Relay would learn of
a cutover only by re-polling `com.atproto.sync.getRepoStatus`. The cutover now
broadcasts an `#account` event (`{ seq, did, time, active, status? }`, with
`status: "deactivated"` when inactive) over the firehose, sharing the same
monotonic `seq` space and `?cursor=` backfill ring as `#commit`, so a Relay
updates the live home in real time. The event is emitted only on an actual
state transition. Adds `encodeAccountFrame` to the frame encoder.
