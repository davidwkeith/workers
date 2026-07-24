---
"@dwk/server": minor
---

Add the opt-in `central` storage mode (spec/scale-out.md, phase 2 of the
horizontal scale-out plan, #431): `HostConfig.storage` now takes
`{ mode: "central", kv, objectStore? }` alongside the default
`{ mode: "local" }`, so N stateless replicas can share centralized D1/R2
stores instead of local SQLite files.

- `assembleCentralBindings(spec)` — the `central`-mode counterpart to
  `assembleBindings`: D1 bindings over `@dwk/deno-host`'s `createD1Database`
  (one injected `LibsqlClientLike` per binding), R2 bindings over
  `createS3Bucket` (an injected `S3ClientLike` + endpoint per binding), and KV
  bindings always backed in-memory per replica (KV is only ever a
  safe-to-be-stale cache, so centralizing it buys nothing).
- `assertNoLocalStores`, `assertModeMarker`, and `probeCentralStores`
  (`central-mode.ts`) — the mode guard and fail-loud startup invariants that
  replace the local-writer lockfile for central mode: `createServer` skips
  `acquireWriterLock` entirely and refuses a `dataDir` still holding
  local-mode stores; the deployer runs the marker check and a round-trip
  probe of every configured store before serving, so an unreachable store is
  a clear startup error rather than a first-request 500.

Durable Objects across replicas (Tier 2) and the queue/cron poller lifecycle
are explicitly out of scope for this phase (spec/scale-out.md §15 phases 3–4).
