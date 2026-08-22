---
"@dwk/atproto-pds": patch
---

Stream `com.atproto.sync.getRepo` (and the `tooBig` firehose fallback it backs)
instead of buffering the whole repository CAR in the Durable Object, closing
#296. `#getRepo` previously decoded every record body up front via `#entries()`
and concatenated the entire CAR into one `Uint8Array` response body — a large
account could overrun the DO's 128 MB memory limit, and every Relay/AppView
full sync hit this path. `#getRepo` now builds its MST entries without decoding
record bodies (`#mstEntries()`), and `car.ts`'s new `writeCarStream` returns a
`ReadableStream` that encodes and enqueues one block at a time as the response
is read, decoding at most one record body from the SQL cursor per pull instead
of the whole repository at once.
