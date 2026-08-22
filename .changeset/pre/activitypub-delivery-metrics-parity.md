---
"@dwk/activitypub": patch
---

Give alarm-driven delivery outcomes `Metrics` counter parity with their log
lines (issue #336). The Durable Object cannot call the injected `Metrics`
seam across the isolate boundary, and — unlike logging, where `console` is a
direct `wrangler tail`-visible escape hatch — there is no direct-to-metrics
equivalent. `activitypub.delivery.succeeded` / `.failed` / `.blocked` counter
deltas now accumulate durably in the DO's SQLite (coalesced by
`(event, fields)`, cardinality-capped with an explicit
`activitypub.metrics.overflow` counter) and are drained to the front door on
the next forwarded request via an internal `x-ap-metrics` response header;
the front door replays them into the injected `Metrics` and strips the
header. Drains are opt-in per request (`x-ap-metrics-drain`) so internal
callers that would not relay the header never consume deltas, and are
bounded per response so a backlog spreads across requests instead of
bursting.
