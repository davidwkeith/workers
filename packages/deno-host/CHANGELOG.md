# @dwk/deno-host

## 0.1.0-beta.0

### Minor Changes

- c677f51: `createDurableObjectNamespace(ctor, options)`: single-writer actor + alarm
  emulation for Deno Deploy (issue #398, host-contract §3.3), built on a
  per-request Deno KV atomic-CAS lease (bounded-retry contention, throwing
  `LeaseContendedError`) rather than a renewed session lease. Alarms are
  indexed directly in KV (not the per-id SQLite file) so `pollAlarms()` — an
  exported tick method the composing app wires to its own periodic trigger
  (`Deno.cron()` on Deno Deploy) — can find due entries with one range scan;
  a throwing handler is retried with exponential backoff (matching
  `@dwk/cf-shims`' schedule) unless it sets its own new alarm first, which
  supersedes the retry. `ctx.acceptWebSocket`/`getWebSockets` is an in-memory
  per-instance socket set ported from `@dwk/cf-shims`, with a documented
  cross-process limitation on live sockets (spec/packages/deno-host.md).
  Overrides the demand gate in `deno-deploy-design.md` §6 for this increment
  only — #399 (queues) and #400 (object storage) stay gated.
- 43f5d48: `createDurableObjectNamespace` gains an opt-in
  `DurableObjectNamespaceOptions.onLeaseAcquired?(idHex, client)` hook (issue
  #432, host-contract §8's growth discipline): called once per dispatch — a
  `fetch()` or an about-to-run `alarm()` (skipped for a superseded/no-op claim)
  — after the id's per-request lease is acquired and before the event runs,
  passed the same `SyncSqliteDatabaseLike` instance `getStorageClient(idHex)`
  returned for that id. This is the injection point a host needs for the
  sync-before-serve rule (spec/scale-out.md §6.2): a different replica may have
  written to an object id's database since this instance last held the lease,
  and the embedded-replica client must sync from its primary before the event
  sees it. This package still takes no dependency on any richer client
  capability — `client`'s static type stays the plain `SyncSqliteDatabaseLike`
  seam, and it is the host's job to narrow it to whatever concrete type its own
  `getStorageClient` constructs and call that type's sync method there.
  Omitting the option (every existing caller) is unchanged behavior. On the
  alarm path, a rejecting hook does not consume a retry attempt — it's treated
  like a lease-acquisition failure (re-posted at `now` with the same
  `retryCount`), since the handler never got a chance to run.
- 6bee3fc: `createS3Bucket({ client, endpoint })`: a thin `R2Bucket`-shaped adapter over
  an external S3-compatible provider (issue #400, host-contract §3.4) —
  `put`/`get`/`head`/`delete` map onto the S3 REST verbs
  `PUT`/`GET`/`HEAD`/`DELETE`. `httpMetadata.contentType` round-trips as the
  `Content-Type` header; `customMetadata` round-trips as `x-amz-meta-*`
  headers (lowercased on read-back, a documented divergence from R2's
  case-preserving behavior). A `ReadableStream` `put` value streams through a
  byte-counting `TransformStream` rather than buffering, so the returned
  `R2Object.size` is known without reading the whole body into memory first.
  The injected `S3ClientLike` seam is a single `fetch`-shaped method already
  configured to sign requests for the target endpoint — most naturally
  `aws4fetch`'s `AwsClient#fetch` — keeping the package dependency-free rather
  than typing against the AWS SDK's `S3Client.send(Command)` surface. This is
  the last of the four gaps `@dwk/deno-host` set out to close (#397, #398,
  #399 landed previously); all four now override the demand gate in
  `deno-deploy-design.md` §6 for this package's shims specifically, while an
  actual deployed Deno Deploy app (Phase 1) stays a separate, still-gated
  decision.
- c867873: `createQueueBroker(kv, options?)`: durable at-least-once queue emulation for
  Deno Deploy (issue #399, host-contract §3.6), built on Deno KV directly —
  the new Deno Deploy platform dropped native Deno Queues with no built-in
  replacement. `producer(name)` returns a `send`/`sendBatch` binding writing
  a due-time-ordered KV entry per message; `consumer(name, handler, options?)`
  registers a handler; `pollQueues()` — an exported tick method the composing
  app wires to its own periodic trigger (`Deno.cron()` on Deno Deploy, sharing
  its cadence with `pollAlarms()`) — atomically claims due entries (so
  concurrent polls can't double-deliver) and invokes the handler with a batch.
  Per host-contract §3.6, a message neither `ack()`'d nor `retry()`'d when the
  handler call ends — including by throwing — is always redelivered (default
  exponential backoff, or the delay from an explicit `retry({delaySeconds})`),
  which is the contract-conforming behavior and intentionally stricter than
  `@dwk/cf-shims`' `QueueBroker` (which auto-acks a quiet return). A
  per-consumer `maxAttempts` drops a message past that cap as a dead-letter
  backstop. Overrides the demand gate in `deno-deploy-design.md` §6 for this
  increment only — #400 (object storage) stays gated.
- 139a2a5: New package: Deno Deploy host building blocks (issue #397, the SQL gap of
  the gated #396 plan). `createD1Database(client)` presents an async remote
  libSQL/Turso client (`@libsql/client`) as a host-contract §3.5 `D1Database`
  — `meta.changes` from `rowsAffected`, atomic in-order `batch` via
  `client.batch(..., "write")`, `exec` via `executeMultiple`.
  `createDurableSqlite(db)` / `createSqlStorage(db)` present libSQL's
  synchronous embedded-replica client (or any better-sqlite3 /
  `node:sqlite`-shaped handle) as the host-contract §3.2 `SqlStorage` +
  `transactionSync` surface, with Cloudflare-style one-shot cursors. Both
  shims are runtime-agnostic and dependency-free, reaching their store only
  through injected structural client seams.

### Patch Changes

- 4cd36af: Add a `bugs` field to every publishable package manifest, so the npm package
  page links to the repository issue tracker instead of omitting the "report
  issues" link entirely. Metadata only — no runtime or API change.
