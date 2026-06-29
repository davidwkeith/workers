---
"@dwk/atproto-pds": patch
---

Complete the firehose `#commit` event body: populate `blobs` and add a `tooBig`
fallback.

- **`blobs`** — a `#commit` now lists the CIDs of blobs newly referenced by the
  records it created/updated (derived from the record content), so a consumer
  knows which blobs to fetch without decoding every record itself. Previously the
  field was always empty.
- **`tooBig`** — because the package rebuilds the whole MST into every frame, a
  large repo's per-commit diff can outgrow the WebSocket message ceiling. When a
  commit's blocks CAR exceeds the new `firehoseMaxBlocksBytes` config (default
  1 MiB), the event is emitted with `tooBig: true`, an empty blocks CAR (carrying
  only the commit root) and no `ops`/`blobs`, signalling the consumer to fall
  back to `getRepo`. Previously `tooBig` was always false and an oversized frame
  could exceed the message limit.

Adds `firehoseMaxBlocksBytes` to `AtprotoPdsConfig` (operator-tunable; also makes
the `tooBig` path testable).
