---
"@dwk/log": minor
"@dwk/webmention": minor
---

Add an injectable **metrics** seam to `@dwk/log` (companion to `Logger`) with an
Analytics Engine adapter, and wire `@dwk/webmention` as its first consumer.

- **`@dwk/log`**: a minimal `Metrics` interface (`count(event, fields?)` /
  `observe(event, value, fields?)`) that reuses the same event taxonomy and
  field bags as `Logger`, a `noopMetrics` default, and
  `analyticsEngineMetrics(dataset, options?)` — an adapter that maps each call
  onto Cloudflare Workers Analytics Engine `writeDataPoint` (event →
  `indexes[0]` + `blobs[0]`, string fields → `blobs`, numeric/boolean fields →
  `doubles`, in sorted key order so positions are stable per event). It enforces
  the AE limits (1 index ≤ 96 B, ≤ 20 blobs ≤ 16 KB total, ≤ 20 doubles), never
  throws into the measured operation, and targets the binding through a
  structural type (`AnalyticsEngineDatasetLike`) so the library keeps no
  `@cloudflare/workers-types` dependency. Injected exactly like `logger` —
  optional, defaulting to a no-op — as two independent seams, not one combined
  `Observer`.
- **`@dwk/webmention`**: `WebmentionConfig`, `VerifyOptions`, `DiscoverOptions`,
  `SendOptions`, and `SafeFetchOptions` now accept an optional `metrics`
  (defaulting to a no-op). The package emits counters mirroring its log events
  on the shared `WebmentionLogEvent` vocabulary: SSRF blocks (by reason),
  receive accepted/rejected, verification outcomes (by links/status), queue
  retries (by reason), and send outcomes (by delivered/status), so an operator
  can chart them rather than scraping log lines.
