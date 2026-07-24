# Horizontal scale-out for the container host (design)

> **Status: proposed — design only, nothing adopted.** This document designs an
> **opt-in scale-out mode** for the container host (`@dwk/server`): N identical
> container replicas behind a load balancer, with **all authoritative state
> moved to centralized data stores**, so a high-traffic site can scale
> horizontally and survive replica loss. It does not change the default: the
> single-process, local-SQLite-and-filesystem design of
> [self-hosting.md](self-hosting.md) remains the recommended path for the
> typical single-owner deployment, and its
> [§4 non-goal](self-hosting.md#4-goals--non-goals-of-the-self-host-path)
> ("horizontal scale / clustering") stays true **for that mode**. Requirement
> strength follows [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Motivation

The container image is the headline self-host artifact
([self-hosting.md §3](self-hosting.md#3-relationship-to-the-cloudflare-target--decided)),
and containers get deployed onto orchestrators — Kubernetes, ECS/Fargate,
Cloud Run, Fly.io, Nomad — whose native scaling model is **replicas behind a
load balancer**. Today the host actively forbids that: authoritative state is
local SQLite files and a local filesystem R2, and `acquireWriterLock`
(`packages/server/src/lock.ts`) refuses a second writer on the same data
directory, because two processes sharing those files would each believe they
are the single writer for a pod and corrupt the consistency/authz model
([self-hosting.md §8](self-hosting.md#8-consistency--correctness)).

That is the right default for one person on one box. It is the wrong ceiling
for the deployments this design targets:

- **High-traffic sites** — a popular blog's Webmention/Micropub endpoints, a
  fediverse account whose ActivityPub inbox sees delivery storms, a Solid pod
  serving many agents — where one Node process is the throughput limit.
- **High availability** — a single replica means every deploy, crash, or node
  drain is downtime; orchestrators want ≥2 replicas and rolling updates.
- **Disk-less platforms** — Cloud Run and similar run containers with
  ephemeral filesystems and scale horizontally by default;
  [portability.md §4.4](portability.md#44-google-cloud--same-shape-as-aws)
  had to rule them out precisely because the local-disk shims and the
  lockfile invariant break there. Centralized stores make those platforms
  viable.

The design constraint, per the user-facing thesis and the
[host contract](host-contract.md): the endpoint packages MUST run
**byte-for-byte unchanged**. Scale-out is a new *binding assembly* inside the
existing host, not a new protocol implementation.

## 2. Constraints inherited from the existing specs

1. **The host contract is the bar.** A scale-out deployment is just another
   conforming host ([host-contract.md](host-contract.md)): the binding
   interfaces, their semantics (per-id single writer, durable single-slot
   alarms, at-least-once queues, read-your-writes D1, read-after-write R2,
   streaming bodies), and the module/global seams. Nothing here may weaken
   §4's consistency table.
2. **SQLite dialect is non-negotiable.** The packages issue raw SQLite SQL
   (`PRAGMA table_info`, `INSERT OR IGNORE`, `ON CONFLICT`); host-contract
   §3.2/§3.5 treat a dialect-translation layer as non-conforming. This rules
   out Postgres/MySQL as the centralized SQL store and points directly at
   **libSQL** (the SQLite fork with a hosted/self-hostable server — sqld /
   Turso), exactly as the Deno Deploy work already concluded
   ([packages/deno-host.md](packages/deno-host.md)).
3. **KV-never-for-authz** and no decision caching outside strongly-consistent
   layers ([non-functional-requirements.md](non-functional-requirements.md))
   apply to every new store introduced here.
4. **Config is injected; the host is the composition root** — mode selection
   and store endpoints live in `HostConfig`, never read from the environment
   inside packages ([composition-contract.md](composition-contract.md)).

## 3. The key enabling fact: the building blocks already exist

This design is deliberately an **assembly**, not an invention. The
[deno-deploy work](deno-deploy-design.md) faced the same fundamental problem —
*multiple isolated instances, no shared disk, all authoritative state must be
external* — and `@dwk/deno-host` (#397–#400) already implemented the four
centralized-store shims in **runtime-agnostic** form (no `node:` imports, no
Deno globals, only injected client seams):

| Building block | `@dwk/deno-host` module | Backing store |
| --- | --- | --- |
| `D1Database` over an async remote client | `createD1Database` (`LibsqlClientLike`) | libSQL/Turso |
| `SqlStorage` + `transactionSync` over a sync embedded-replica client | `createSqlStorage` / `createDurableSqlite` (`SyncSqliteDatabaseLike`) | libSQL embedded replica |
| Per-id single-writer lease + durable alarms + DO namespace | `acquireLease` / `alarms.ts` / `createDurableObjectNamespace` (`DenoKvLike`) | any CAS-capable KV |
| Durable at-least-once queue broker | `createQueueBroker` (`DenoKvLike`) | same KV |
| `R2Bucket` over S3-compatible storage | `createS3Bucket` (`S3ClientLike`, a signing `fetch`) | any S3-compatible store |

The `DenoKvLike` seam is a *structural interface with CAS semantics*, not a
Deno dependency — nothing in `lease.ts`/`alarms.ts`/`queue.ts` touches a Deno
global. On Node the `libsql` npm package (the embedded-replica sync client)
loads natively, which is the one piece the Deno platform still has to verify.

What scale-out mode actually adds is therefore small:

1. A **`DenoKvLike` implementation over libSQL** (§8) so the lease/alarm/queue
   machinery runs against the same centralized SQL service as everything else
   — no Redis, no second coordination technology.
2. A **`central` storage mode** in `@dwk/server`'s bindings assembly and
   `HostConfig` (§9), composing the `@dwk/deno-host` shims instead of the
   `@dwk/cf-shims` local ones.
3. **Fleet-aware lifecycle**: per-replica pollers for alarms/queues, a cron
   tick lease so scheduled handlers fire once fleet-wide (§7), and drain-aware
   shutdown (§12).
4. **WebSocket placement rules** for the load balancer (§6.4).

## 4. Topology

```
                        ┌────────────────────────────┐
     clients ──────────▶│  load balancer / ingress    │  (TLS, affinity for WS)
                        └──────┬─────────┬───────────┘
                               │         │
                 ┌─────────────▼──┐   ┌──▼─────────────┐
                 │ @dwk/server #1 │   │ @dwk/server #N │   … identical replicas,
                 │  (stateless)   │   │  (stateless)   │     ephemeral disk only
                 └───┬────────┬───┘   └───┬────────┬───┘     (embedded-replica cache)
                     │        │           │        │
        ┌────────────▼────────┴───┐   ┌───▼────────▼───────────┐
        │  libSQL service (sqld /  │   │  S3-compatible object   │
        │  Turso): D1 databases,   │   │  store (MinIO / R2 /    │
        │  per-object DO databases,│   │  B2 / S3): blob bodies  │
        │  coordination KV (§8)    │   │  and media              │
        └──────────────────────────┘   └─────────────────────────┘
```

- **Replicas are stateless and interchangeable.** Any replica can serve any
  request; correctness never depends on which replica the load balancer
  picked (WebSockets are the one qualified exception, §6.4). Local disk is
  only a rebuildable cache (embedded-replica files).
- **Exactly two centralized services**, both self-hostable as containers in
  the same deployment (`sqld` and MinIO) or consumable as managed services
  (Turso and any S3-compatible provider). Keeping the coordination store
  *inside* libSQL (§8) is a deliberate choice to avoid a third service.
- The **load balancer** is the user's (ingress controller, ALB, Fly proxy…),
  exactly as TLS termination already is in the single-process design
  ([self-hosting.md §12](self-hosting.md#12-security)).

## 5. Binding-by-binding mapping

| Binding | Local mode (today) | Central mode (this design) |
| --- | --- | --- |
| D1 | `@dwk/cf-shims` `node:sqlite` file | `@dwk/deno-host` `createD1Database` over `@libsql/client` — **one logical libSQL database per D1 binding**, all queries at the primary (read-your-writes, host-contract §3.5) |
| R2 | `@dwk/cf-shims` filesystem + sidecars | `@dwk/deno-host` `createS3Bucket` over a signing `fetch` (`aws4fetch`), streaming both ways |
| KV namespaces | SQLite file or memory | **Per-replica in-memory** (`@dwk/cf-shims` memory mode). KV is only ever a safe-to-be-stale cache, so replica-local caches that diverge briefly are conforming *and* faster than a centralized KV — this is the one binding that deliberately does **not** centralize |
| Durable Objects | in-process singleton + per-id mutex + per-id SQLite file | `@dwk/deno-host` `createDurableObjectNamespace`: libSQL-KV lease per id (§6.1) + per-id libSQL database via embedded replica (§6.2) + KV-indexed alarms (§6.3) |
| Queues | `@dwk/cf-shims` SQLite-backed broker | `@dwk/deno-host` `createQueueBroker` over libSQL-KV, polled by every replica (§7.1) |
| Cron | per-process timer | per-replica timer + fleet-wide tick lease (§7.2) |
| Secrets | env-injected `Env` members | unchanged — identical env on every replica |
| `cloudflare:workers`, `HTMLRewriter`, `DigestStream`, `WebSocketPair` | `@dwk/cf-shims` loader hook + polyfills | unchanged — these are per-process runtime seams, not storage |

The mode is chosen **per deployment, wholesale** — mixing local-mode and
central-mode bindings in one deployment is forbidden (§9.3). One deliberate
consequence: local mode's `assembleBindings` stays untouched, and central
mode gets its own assembly function beside it.

## 6. Durable Objects across replicas

The DO guarantees (host-contract §3.3) are the hard part, exactly as they
were for the Node host and again for Deno Deploy. The design adopts
`@dwk/deno-host`'s implemented per-request-lease model unchanged in v1, with
a residency upgrade sketched as v2 (§6.5).

### 6.1 Single writer: per-request lease

Every `stub.fetch(request)` / alarm delivery acquires the id's lease in the
coordination KV (`["dwk_lease", className, idHex]`, atomic
check-versionstamp-null + set with `expireIn`), runs the event, and releases
in a `finally`. Within one replica, the process-local per-id promise chain
(ported from `@dwk/cf-shims`) still serializes concurrent same-id deliveries;
the KV lease is what enforces the guarantee **across** replicas. Contention
backs off exponentially up to `leaseAcquireTimeoutMs`, then surfaces as
`LeaseContendedError` → the host maps it to `503` + `Retry-After` (a load
balancer retry against the same URL is safe — the winning replica holds
consistency).

The lease TTL (`leaseTtlMs`, default well above p99 event latency) is a crash
safety net: a replica that dies mid-request frees the id automatically. This
is the same recover-from-death role the lockfile's stale-pid reclaim plays in
local mode, moved into the store.

### 6.2 `SqlStorage`: per-object libSQL database, embedded replica

`transactionSync` and `sql.exec` are synchronous surfaces; an async remote
client cannot back them (the resolved design decision in
[packages/deno-host.md](packages/deno-host.md#the-synchronous-gap-resolved-design-decision)).
Each object id maps to its own libSQL database at the primary
(`getStorageClient(idHex)`), and the serving replica opens it through the
`libsql` package's **embedded replica** client: reads are local and
synchronous against a replica file on the container's scratch disk; writes
block the event loop while forwarded to the primary — which is precisely the
"whole DO event loop blocks until commit" semantics the contract's
"synchronous" wording encodes. The replica file is a cache: a rescheduled
container re-syncs from the primary on first access, so ephemeral disk is
sufficient (and disk-less platforms need only a tmpfs-sized scratch mount).

**Sync-before-serve rule:** because a different replica may have held the
lease (and written to the primary) since this replica last touched an id, the
embedded replica MUST be synced **after acquiring the lease and before the
event runs**. Lease + sync-on-acquire together restore the "one live
instance, reading its own writes" model; skipping the sync would serve stale
reads and is a correctness bug, not an optimization.

One libSQL server hosts many databases, so "database per object" costs a
namespace entry, not a service. Very hot deployments can later shard object
databases across multiple sqld primaries by id hash without touching the
packages (§11.3).

### 6.3 Alarms

`@dwk/deno-host`'s KV-indexed alarm design carries over verbatim:
`["dwk_alarm_due", className, epochMs, idHex]` as the ordered due index,
`["dwk_alarm_by_id", className, idHex]` as the single slot, claim-then-dispatch
with CAS so overlapping polls fire an alarm exactly once, and retry-after-throw
written as a *new* due entry (discoverable by any replica) rather than an
in-process timer. The one improvement Node containers get for free: the poll
tick is a real per-replica interval timer (default ~1 s, jittered), not a
platform cron with undocumented granularity — so alarm latency is bounded by
the configured tick, and `activitypub` delivery retries / `atproto-pds` PLC
genesis retries keep near-Cloudflare timing.

### 6.4 WebSockets: pinned to the terminating replica

A live socket is inherently pinned to the replica that terminated the
upgrade; its `webSocketMessage`/`webSocketClose` events do not re-acquire the
per-request lease. This is the same documented limitation as
[packages/deno-host.md](packages/deno-host.md#websocket-support-host-contract-33-rule-3),
and in v1 it is handled operationally, not architecturally:

- The load balancer SHOULD enable **session affinity** for the WebSocket
  upgrade paths (the Solid notifications endpoint, the atproto firehose), so
  a client's socket and its follow-up requests land on the same replica where
  possible.
- The consequences of a lease moving while a socket stays open are bounded:
  the socket-holding replica can push **stale-but-safe** notifications
  (notification fan-out is advisory, not authz), and any *write* arriving over
  the socket path still goes through lease acquisition. The design accepts
  this window in v1 and documents it; deployments for which it is
  unacceptable should keep DO-WebSocket packages on a single replica
  (`replicas: 1` for the pod service, scale the stateless cohort separately)
  or wait for v2.

> **Update (issue #432): Tier 2 implemented** for the mechanism (§6.1–§6.3);
> real per-package lifecycles are proven for one representative package
> (`activitypub`), with the remaining four left as an explicit follow-up (see
> below).
>
> - **§6.1 (lease)**: unchanged from `@dwk/deno-host`'s existing
>   `acquireLease`/`releaseLease`; the one gap this issue closed is the *host
>   mapping* — `@dwk/server`'s `server.ts` `dispatch()` now catches
>   `LeaseContendedError` specifically and responds `503` + `Retry-After: 1`
>   instead of falling through to the generic `500` handler.
> - **§6.2 (sync-before-serve)**: `@dwk/deno-host`'s
>   `createDurableObjectNamespace` gained a new, opt-in
>   `DurableObjectNamespaceOptions.onLeaseAcquired?(idHex, client)` hook —
>   called once per dispatch, after the lease and before the event runs (see
>   `spec/packages/deno-host.md` "Design: sync-before-serve hook (issue
>   #432)"). `@dwk/server`'s new `central-durable-object.ts`
>   (`createCentralDurableObjectNamespace`) wraps that hook to call
>   `client.sync()` **unconditionally** — the rule is structural (baked into
>   the wrapper every central-mode DO namespace is built through), not
>   something a deployer can forget. `EmbeddedReplicaClientLike` is the small
>   type (`SyncSqliteDatabaseLike & { sync(): Promise<void> }`) a deployer's
>   `getStorageClient` factory must return — `@dwk/server` does not construct
>   embedded-replica connections itself, same seam-injection posture as every
>   other central-mode store (`libsql-native.smoke.test.ts` is the one place
>   in the package that imports the real `libsql` npm package at all, and only
>   as a `devDependency`-gated check that the native module loads on Node —
>   see the "Out of scope" note below).
> - **§6.3 (alarms)**: `@dwk/server`'s new `central-do-poller.ts`
>   (`DurableObjectAlarmPoller`) is the per-replica jittered interval timer
>   (default ~1 s + jitter, mirroring `@dwk/cf-shims`'s `CronScheduler` in
>   shape) that drives every registered namespace's `pollAlarms()` and,
>   optionally, `LibsqlKv.sweepExpired` on the same tick — required because,
>   unlike `@dwk/cf-shims`'s local-mode shim, `@dwk/deno-host`'s namespace
>   never auto-arms a timer for a scheduled alarm.
> - **A previously-unremarked simplification**: the endpoint packages import
>   their `DurableObject` base class from the `cloudflare:workers` bare
>   specifier, resolved today to `@dwk/cf-shims`'s shim (via
>   `registerCloudflareWorkers`/the vitest alias). That base class only wires
>   `ctx`/`env` fields in its constructor and carries no other behavior, so
>   which concrete `DurableObject` class a package's `extends` clause resolved
>   to at *import* time is irrelevant at *construction* time: constructing the
>   exact same class through `@dwk/deno-host`'s namespace (whose `ctx`/`env`
>   are structurally compatible) works completely unmodified. **No second
>   loader hook or build-time alias is needed for central mode** — this was
>   left open in earlier phases' text and is resolved here.
> - **Testing**: `central-durable-object.test.ts` and `central-do-poller.test.ts`
>   cover the mechanism against `central-test-harness.ts`'s new
>   `FakeEmbeddedReplicaClient` (a `node:sqlite`-backed fake reproducing a real
>   embedded replica's observable contract — writes forward to a shared
>   "primary" and are reflected locally immediately, reads and `sync()` only
>   ever touch the local file — without needing a live libSQL server).
>   `central-do.integration.test.ts` is the §14 item 2/3 suite over two real
>   `DwkServer` HTTP replicas: sync-before-serve (write via A, read via B),
>   racing writes to one id serialize (never interleaved), and crash recovery
>   (a replica that never releases its lease frees the id for another after
>   `leaseTtlMs`). `central-do-activitypub.integration.test.ts` is the one real
>   Tier-2 lifecycle this issue brings up end to end across two replicas — the
>   inbound-`Follow`-to-alarm-driven-`Accept` flow from
>   `phase5-activitypub.integration.test.ts`, with `ActivityPubObject` used
>   completely unmodified. **The other four Tier-2 packages'
>   (`solid-pod`/`remotestorage`/`webauthn`/`atproto-pds`) cross-replica
>   lifecycle suites are not implemented here** — the mechanism they'd exercise
>   is identical to what `activitypub`'s suite already proves (same namespace
>   wrapper, same poller, same lease), so this is scoped as a follow-up rather
>   than four more copies of the same proof; a package with WebSocket-specific
>   lifecycle behavior over central mode is the one case that would need new
>   coverage of its own, not just a port of its phase5 suite (see §6.4 above).
> - **Out of scope, per this issue's own scoping**: live Turso/sqld
>   verification (the embedded-replica smoke test is Node-native-module-only,
>   against no configured `syncUrl`); the fleet lifecycle items (queue poller,
>   cron tick lease, drain, readiness — phase 4).

### 6.5 v2 sketch (not in scope): residency leases + internal forwarding

The per-request lease pays one KV round-trip per DO event and leaves the
WebSocket gap above. The classic actor-system answer is **residency**: a
replica acquires a *long-lived* lease for an id (renewed on a heartbeat),
becomes the id's home, and other replicas **forward** `stub.fetch` to it over
an internal HTTP hop instead of contending; sockets and residency then move
together, closing §6.4's gap and amortizing lease traffic for hot objects.
This is a real distributed-systems increment (failure detection, forwarding
tier, split-brain analysis) and is explicitly deferred until per-request
leasing is measured to be a bottleneck — the seams (`DurableObjectNamespace`
behind `createDurableObjectNamespace`) already leave room for it.

## 7. Queues and cron across the fleet

### 7.1 Queues

Producers (`queue.send`/`sendBatch` from `webmention`/`microsub`/`websub`
handlers on any replica) write due-index entries to the coordination KV;
**every replica runs the poll loop** (`pollQueues`, per-replica interval
timer with jitter). The claim step is CAS-delete, so two replicas racing the
same message deliver it once; adding replicas adds consumer throughput with
no coordination beyond the claims themselves. `attempts`, `retry({
delaySeconds })`, exponential default backoff, and the `maxAttempts`
dead-letter backstop all come from `@dwk/deno-host`'s broker unchanged —
including its **conforming** redeliver-by-default semantics (a message
neither acked nor retried is redelivered), which host-contract §3.6 requires
and which `@dwk/cf-shims`' broker currently gets wrong (it auto-acks); scale
-out mode uses the conforming broker.

### 7.2 Cron

The scheduled handlers (microsub poller, R2 GC) are idempotent, but running
them on N replicas multiplies load for no benefit and widens GC race windows.
Each replica ticks on the configured cadence and first attempts a short-lived
**tick lease** — `["dwk_cron", handlerName, tickBucket]` set atomically with
`expireIn` covering the cadence — where `tickBucket` is the tick's scheduled
time rounded to the cadence. Exactly one replica wins and runs the handler;
losers skip silently. A winner that crashes mid-run is covered by handler
idempotency plus the next tick (missed-tick coalescing is already permitted
by host-contract §3.7).

## 8. The coordination store: `DenoKvLike` over libSQL

The lease/alarm/queue machinery needs a small strongly-consistent KV with
CAS, TTL, and ordered range scans. Rather than introduce a third service
(Redis, etcd, FoundationDB), scale-out mode implements the existing
`DenoKvLike` seam **on the libSQL service already required for SQL** — one
dedicated logical database, one table:

```sql
CREATE TABLE IF NOT EXISTS kv (
  k          BLOB PRIMARY KEY,   -- order-preserving tuple encoding of the key array
  v          TEXT NOT NULL,      -- JSON value
  ver        INTEGER NOT NULL,   -- per-key monotonic versionstamp
  expires_at INTEGER             -- epoch ms, NULL = no TTL
);
```

- **Key encoding MUST be order-preserving** across the key-part types the
  consumers use (strings and numbers): the alarm/queue due indexes range-scan
  `[prefix … now]` and depend on numeric parts sorting numerically (an
  element-tagged encoding with big-endian, sign-flipped 8-byte numerics —
  the same property `Deno.Kv` guarantees natively and
  [packages/deno-host.md](packages/deno-host.md) lists as live-verification
  item 5).
- **`atomic().check(...).set/delete(...).commit()`** maps to one libSQL
  transaction: `SELECT ver` for each check (a `versionstamp: null` check
  asserts absence), abort with `{ ok: false }` on mismatch, else apply
  mutations bumping `ver`. `batch(..., "write")` — one implicit transaction,
  already the seam's contract — is sufficient; primary-only access gives
  serializability.
- **`expireIn`** becomes `expires_at`; reads and range scans treat expired
  rows as absent, and the poll ticks lazily delete them (mirroring the lease
  design's crash-safety role; precise-to-the-ms expiry is not required, only
  "expired is never returned").
- **`list({ prefix, start, end }, { limit })`** is an indexed range `SELECT`
  over the primary key.

**Placement:** the adapter (working name `LibsqlKv`) starts as a module in
`@dwk/server` — private, first consumer — mirroring exactly how the
Cloudflare shims lived in `@dwk/server` until a second consumer justified the
`@dwk/cf-shims` extraction (#381). If the Deno host (or a future host) wants
it, extraction is mechanical.

> **Update (issue #428): implemented** as
> `packages/server/src/libsql-kv.ts` (`LibsqlKv`, plus the exported
> `encodeKvKey`/`decodeKvKey` codec), with the §14-item-1 unit tests and the
> §14 integration posture's first slice (the real `@dwk/deno-host`
> lease/alarm/queue-broker code driven against `LibsqlKv`, including the
> two-replica claim race) colocated in `libsql-kv.test.ts`. Two design
> refinements from the sketch above, both invisible to the seam's consumers
> (equality-only CAS): the versionstamp is a **store-wide** monotonic
> sequence rather than per-key (`kv_meta.seq` — a per-key counter could
> reissue a stamp after a sweep deletes and a later write recreates the key,
> letting a stale CAS wrongly succeed), and all `set`s in one atomic commit
> share one stamp. Checks are evaluated into a scratch column
> (`kv_meta.ok`) **before** any mutation in the same `batch(...,"write")`
> transaction, so mutations are guarded by pre-mutation state exactly as the
> seam's reference semantics require. Phases 2+ (wiring it into a `central`
> mode) remain unimplemented.

**Alternatives considered and rejected:**

- *Redis/Valkey* — adds a third centralized service and a new client
  dependency for semantics libSQL already provides at this scale; the
  coordination workload (leases, alarm/queue indexes) is small compared to
  the SQL workload sharing the service.
- *Postgres for coordination only* — the SQLite dialect rule binds only the
  `SqlStorage`/`D1` surfaces, so Postgres *would* be conforming here, but it
  is strictly worse than reusing the mandatory libSQL service.
- *Object-store conditional writes* — S3 `If-Match` CAS is too coarse (no
  ordered scans, no TTL) and per-operation latency is worse.

## 9. Configuration, mode selection, and the writer-lock story

### 9.1 `HostConfig` surface

`HostConfig` gains a discriminated `storage` member (default preserves
today's behavior exactly):

```ts
storage?:
  | { mode: "local" }                       // default — today's behavior
  | {
      mode: "central";
      libsql: {
        url: string;                        // sqld / Turso endpoint
        authToken?: string;
        /** scratch directory for embedded-replica files (ephemeral OK) */
        replicaDir: string;
      };
      objectStore: {
        endpoint: string;                   // path-style URL incl. bucket
        /** an already-signing fetch, e.g. aws4fetch's AwsClient#fetch */
        client: { fetch(input: string | URL, init?: RequestInit): Promise<Response> };
      };
      /** poll cadence for alarms + queues (default ~1000 ms, jittered) */
      pollIntervalMs?: number;
      leaseTtlMs?: number;
      leaseAcquireTimeoutMs?: number;
    };
```

A `central`-mode counterpart to `assembleBindings` composes the
`@dwk/deno-host` shims from this config; the `Mount`/`assertBindings`/
`resolveOrigin` machinery is unchanged. Per the composition contract, the
host remains the only place that reads the environment to build this config.

### 9.2 Fail-loud startup probes

Local mode fails loudly on missing files/secrets; central mode MUST fail
loudly on unreachable or misconfigured services **at startup, not first
request**: a round-trip write/read/delete probe against the coordination KV,
each D1 database, and the object store (and an embedded-replica open+sync for
a sentinel database). A replica that cannot reach its stores MUST exit
non-zero so the orchestrator restarts it rather than serving 500s.

### 9.3 The writer lock becomes a mode guard

`acquireWriterLock` exists to stop two processes sharing local files. In
central mode the per-id lease **is** the single-writer mechanism, so the
lockfile is not acquired — replicas are *supposed* to coexist. What replaces
it is a **mode marker**, both directions:

- Central mode writes a `["dwk_meta", "mode"]` marker in the coordination KV
  and refuses to start if a marker from an incompatible layout/version is
  present; it also refuses a `dataDir` that contains local-mode authoritative
  stores (`d1/`, `r2/`, `do/`), so a deployment cannot half-migrate by
  accident.
- Local mode continues to acquire the lockfile, unchanged.

The invariant generalizes from "exactly one process writes a given data
directory" to **"a given store set is written under exactly one mode, and
each DO id under exactly one lease holder at a time."**

> **Update (issue #431): Tier 1 implemented**, with two deliberate deviations
> from §9.1's sketch above:
>
> 1. `HostConfig.storage`'s `central` variant takes `kv: DenoKvLike` (an
>    already-constructed coordination store, typically a `LibsqlKv` over an
>    injected libSQL client) rather than a raw
>    `{ url, authToken, replicaDir }` connection descriptor — consistent with
>    every other `@dwk/deno-host` seam's "the composing app injects an
>    already-connected client, the package never constructs one" philosophy
>    (`objectStore.client` already worked this way). `@dwk/server` gains no
>    new client-library dependency as a result.
> 2. `replicaDir`, `pollIntervalMs`, `leaseTtlMs`, and `leaseAcquireTimeoutMs`
>    are dropped from the type entirely rather than carried as unconsumed
>    fields — nothing in this phase reads them (they're phase 3/4 concerns:
>    the embedded-replica `SqlStorage` cache directory and the lease/alarm/
>    queue poller cadence). Add them back when phase 3/4 code actually
>    consumes them; an unused reserved field is dead API surface, not
>    forward-compatibility.
>
> Implemented as `packages/server/src/central-bindings.ts`
> (`assembleCentralBindings`: D1 via `@dwk/deno-host`'s `createD1Database` over
> an injected `LibsqlClientLike` per binding, R2 via `createS3Bucket` over an
> injected `S3ClientLike` + per-binding endpoint, KV always `@dwk/cf-shims`'
> in-memory backing) and `packages/server/src/central-mode.ts`
> (`assertNoLocalStores`, `assertModeMarker`, `probeCentralStores` — the §9.2/
> §9.3 invariants). `createServer` itself only handles the *synchronous* half
> unconditionally: skipping `acquireWriterLock` and calling
> `assertNoLocalStores` when `storage.mode === "central"`. The async marker/
> probe checks are structurally required, not merely documented, via
> `createCentralServer` (`server.ts`) — a thin wrapper that runs them (building
> the object-store probe target straight from `storage.objectStore`) before
> delegating to `createServer`, so a central-mode deployment that uses it gets
> the same "impossible to skip the fail-loud startup check" guarantee
> `assertBindings` gives local mode automatically; calling `createServer`
> directly still works but bypasses both checks. `examples/central-composition.mjs`
> demonstrates the full deployer-invoked sequence end to end (a standalone
> runnable script, not a `dwk-serve` config module — the CLI's `startServer`
> doesn't yet know about `createCentralServer`, a follow-up).
>
> The §14 item 2 multi-replica integration slice
> (`packages/server/src/central.integration.test.ts`) boots two `DwkServer`
> instances (via `createCentralServer`) against the same `dataDir` sharing one
> fake libSQL backing and one in-memory S3 fake, proving: central mode never
> contends the writer lockfile, a D1 write on replica A is visible from
> replica B (read-your-writes), an R2 body written on A streams back out
> through B, and both replicas' startup probes/mode-marker checks agree.
> Durable Objects (Tier 2, phase 3) and the
> queue/cron poller lifecycle (phase 4) remain unimplemented, as scoped.

## 10. Consistency review (host-contract §4)

| Store | Contract requirement | Central mode |
| --- | --- | --- |
| DO SQLite | Serialized per id; `transactionSync` atomicity | KV lease (CAS + TTL) across replicas, per-id chain within one; sync-before-serve on lease acquire (§6.2); SQLite transaction at the embedded replica, forwarded atomically to the primary |
| D1 | Read-your-writes; atomic `batch` | All queries at the libSQL primary; `batch` = one libSQL transaction |
| R2 | Read-after-write | Per-key guarantee of the chosen S3-compatible provider — MUST be verified per provider (same live-verification posture as [packages/deno-host.md](packages/deno-host.md), item 8) |
| Queues | Durable, at-least-once | KV entries are durable rows in libSQL; claim-then-requeue (never un-delete) makes redelivery-until-acked the only path |
| KV namespaces | (safe-to-be-stale only) | Per-replica memory — divergence between replicas is exactly the staleness the rule already permits |

No new store is eventually consistent; the design stays on the right side of
the rule that disqualified Fastly
([portability.md §4.2](portability.md#42-fastly-compute--blocked-on-consistency)).

## 11. Performance analysis and honest costs

### 11.1 What each request pays

| Path | Local mode | Central mode |
| --- | --- | --- |
| Stateless endpoint, D1-backed | in-process SQLite (µs) | 1 network round-trip per query to the libSQL primary (~ms, deployment-local) |
| R2 body | local file stream | streamed to/from the object store (network, still unbuffered) |
| DO event | in-process mutex | lease CAS (+ release) + replica sync-on-acquire + write forwarding to the primary |
| Queue/alarm delivery | timer-immediate | bounded by `pollIntervalMs` (default ~1 s) |

Central mode trades single-request latency for aggregate throughput and
availability. That trade is the point — but it means **local mode remains
faster for one user on one box**, and the docs MUST keep recommending it
there.

### 11.2 What scales linearly

The stateless front door (routing, token validation, static files), all
Tier 1 endpoints (their state is at the primary; replicas add CPU/TLS/parse
capacity), queue consumption (claim-based), and R2 streaming (replicas are
just pipes). These cover the actual high-traffic profiles: webmention storms,
micropub media, fediverse delivery bursts, feed polling fan-out.

### 11.3 What does not (and the levers)

- **The libSQL primary is the write ceiling.** All D1 writes and all DO
  write-forwarding land on it. Levers, in order: it's SQLite — a single
  decent primary goes a long way; per-object databases shard **naturally**
  by id hash across multiple sqld primaries (the `getStorageClient(idHex)`
  seam already takes the id); D1 databases can each live on their own
  primary. None of this touches package code.
- **A single hot DO id is serialized by design** — per-id single-writer is
  the contract, not a bug; no mode changes that ceiling (Cloudflare has the
  same one).
- **Lease latency on DO-heavy workloads** — the v2 residency sketch (§6.5)
  is the lever if measurement demands it.

## 12. Operations

- **Health:** a liveness endpoint (process up) and a readiness endpoint that
  re-runs the §9.2 probes cheaply (cached, ~seconds); replicas failing
  readiness are pulled from the balancer without killing in-flight work.
- **Graceful drain, in order:** stop accepting new connections → stop the
  alarm/queue/cron pollers (claimed-but-unfinished messages redeliver by
  contract; in-flight polls finish) → drain the `WaitUntilTracker` → close
  WebSockets with a going-away code → release any held leases via the normal
  `finally` paths → exit. Rolling deploys then need no special casing: old
  and new replicas coexisting is the *normal* state, made safe by leases and
  claims rather than by deployment choreography.
- **Backups centralize** — sqld/Turso snapshots + object-store lifecycle
  replace "back up the data directory," and replica scratch disks need no
  backup at all.
- **Observability:** new `@dwk/log` events for lease acquire/contend/expire,
  poll-tick lag and claimed-batch sizes, replica sync duration, and probe
  failures — the fleet's health is legible only through these
  ([observability.md](observability.md) taxonomy applies).

## 13. Migration between modes

Mechanical in both directions, extending the
[self-hosting.md §14](self-hosting.md#14-data-portability) portability story:

- **D1 / per-object DO databases:** same dialect, same schemas — each local
  `.sqlite` file imports as one libSQL database (and back).
- **R2:** each object file + metadata sidecar becomes one S3 `PUT` with
  content-type and `x-amz-meta-*` headers (and back).
- **Pending alarms:** local mode persists the alarm *inside* each object's
  SQLite file; migration MUST lift these into the coordination KV's due/by-id
  indexes, or scheduled retries would be silently lost.
- **Queue backlog:** drain the local queue before migrating (simplest), or
  import pending rows as KV due entries.
- **KV namespaces:** caches; not migrated.

A `dwk migrate` subcommand covering local ↔ central (and, combined with the
existing story, Cloudflare ↔ either) is the natural follow-on deliverable.

> **Update (issue #434): implemented** as `packages/server/src/migrate.ts`
> (the `dwk-migrate` bin, `@dwk/server`'s second CLI entry alongside
> `dwk-serve`, also exported as plain functions from `@dwk/server/migrate`
> for scripting). D1/DO-SQLite dump-and-replay is genuinely dialect-identical
> (schema DDL from `sqlite_master` + a full-table `SELECT`, replayed as one
> write transaction/batch on the other side) and runs in both directions;
> R2 migration streams each object (no full-body buffering) and preserves
> content-type/custom metadata both ways. The two sharp edges above are
> handled structurally, not left as a manual step: every DO-object migration
> function (`migrateDoObjectToCentral`/`migrateDoObjectToLocal`) calls
> `liftPendingAlarm`/its lowering counterpart as part of the same call, so a
> pending alarm can't be silently dropped by forgetting a separate step; and
> `importQueueBacklog` imports a local queue's non-dead backlog into the
> coordination KV as due entries (the documented alternative to draining),
> resetting each message's attempt counter to 0 on import — safe for an
> at-least-once queue, and no `@dwk` consumer depends on preserving it across
> a migration.
>
> **One asymmetry, deliberate rather than an oversight:** `to-central`
> (`migrateLocalToCentral`) scans `dataDir` the same way `bindings.ts`
> assembles one and migrates whatever binding the caller's
> `CentralMigrationTarget` declares a client for, reporting any `dataDir`
> entry with no matching binding as `skipped` (never silently dropped).
> `to-local` (`migrateCentralToLocal`) cannot do the equivalent discovery —
> central mode has no directory to list (each D1 binding is one opaque
> logical database; each DO object is its own database; and
> `@dwk/deno-host`'s `S3ClientLike` deliberately has no `list`, per its own
> doc comment — no production consumer needs it) — so `to-local` takes an
> explicit `LocalMigrationTarget` naming exactly what to pull down (R2
> migration in this direction needs its key set supplied the same way, e.g.
> from `@dwk/store`'s own D1 registry of the keys it wrote). This mirrors
> the same "no generic list" posture the R2 shim itself already documents,
> rather than inventing bespoke S3 `ListObjectsV2` handling this package
> doesn't otherwise need.

## 14. Testing plan

1. **`LibsqlKv` unit tests** — CAS under interleaving, absence checks, TTL
   expiry, and (critically) **key-encoding order**: numeric parts must
   range-scan in numeric order; property-style tests comparing scan order
   against a sorted in-memory model. Runs against in-memory `node:sqlite`
   via the existing seam fakes — no live service in unit tests.
2. **Multi-replica integration** — the decisive suite: boot **two
   `DwkServer` instances in one vitest process** sharing one `LibsqlKv` + one
   SQL backing + one `FakeS3Client`, then drive the existing phase-style
   lifecycles across them: racing same-pod writes serialize (one
   `LeaseContendedError`/queued winner, never interleaved state); an alarm
   scheduled via replica A fires exactly once though both replicas poll; a
   queue message sent on A delivers once on either; cron tick lease admits
   one runner; kill replica A mid-request and assert B recovers the id after
   lease TTL.
3. **Sync-before-serve regression** — write via A, immediately read via B,
   assert B sees it (this is the test that fails if §6.2's sync rule is
   skipped).
4. **Live verification before any "supported" claim** — inherits
   [packages/deno-host.md](packages/deno-host.md)'s list against real
   services: libSQL read-your-writes and `batch` atomicity over hrana,
   embedded-replica transaction forwarding **under concurrent replicas**,
   S3 provider read-after-write, streaming-body signing; plus sqld behavior
   under sustained multi-writer lease traffic. A docker-compose reference
   (sqld + MinIO + 2 replicas) doubles as the test bed and the deployment
   example.
5. **Conformance** — per [host-contract.md §9](host-contract.md#9-conformance-tiers-and-how-a-host-proves-compliance),
   a scale-out deployment earns "supported" only after the hosted suites run
   against a ≥2-replica target.

   > **Update (issue #434): the runbook and its test bed are implemented**,
   > the runs themselves are not — central mode stays **experimental**, not
   > supported, until they're recorded passing.
   > `packages/server/docker-compose.yml` is the sqld + MinIO + 2-replica
   > topology this item calls for (both replicas building from
   > `examples/central-composition.mjs` via the existing `Dockerfile`,
   > parameterized with a new `BUNDLE_ENTRY` build arg); the fillable
   > checklist for both this item and item 5 lives at
   > [`conformance/scale-out-qa.md`](../conformance/scale-out-qa.md), which
   > `conformance/README.md` now links from a dedicated "Central mode
   > (scale-out) live verification" section. Every item above maps to a
   > numbered, concretely-actionable step in that runbook (e.g. item 3's
   > "embedded-replica transaction forwarding under concurrent replicas"
   > maps to "write via `server1`, immediately read via `server2`, confirm
   > no lag" — the same assertion `central-do.integration.test.ts` already
   > proves against fakes, restated against the real services). `packages/
   > server/k8s-notes.md` is the phase 5 packaging deliverable for
   > production topologies beyond the compose reference itself
   > (`Deployment` vs `StatefulSet`, readiness/liveness probe shape,
   > WebSocket affinity via ingress annotations, `emptyDir` scratch volumes
   > for `replicaDir`).

## 15. Phased implementation plan

1. **`LibsqlKv`** in `@dwk/server` (+ unit tests, key-encoding property
   tests). No behavior change for existing users.
2. **Central-mode Tier 1**: `storage` config + central bindings assembly
   (D1 via `@dwk/deno-host`, R2 via `createS3Bucket`, per-replica memory KV),
   startup probes, mode marker. Mount the IndieWeb trio + stateless cohort;
   multi-replica integration for the stateless/D1 paths.
3. **Central-mode DOs (Tier 2)**: namespace over
   `createDurableObjectNamespace` + `LibsqlKv`, embedded-replica
   `getStorageClient` with sync-before-serve, alarm poller. Bring up
   `solid-pod`/`activitypub`/`remotestorage`/`webauthn`/`atproto-pds`
   lifecycles across two replicas.
   > **Update (issue #432): mechanism implemented**, one package
   > (`activitypub`) proven end to end across two replicas; see the §6 update
   > note above for what's implemented, the simplification found along the
   > way, and why the other four packages' lifecycle suites are scoped out as
   > a follow-up rather than duplicated proof.
4. **Fleet lifecycle**: queue poller on every replica, cron tick lease,
   drain-aware shutdown, readiness endpoint, observability events.
5. **Packaging & docs**: docker-compose reference (sqld + MinIO + N
   replicas), k8s notes (affinity for WS paths, scratch volumes), `dwk
   migrate` local↔central, README guidance on when *not* to use this mode.

   > **Update (issue #434): implemented.** `packages/server/docker-compose.yml`
   > (sqld + MinIO + 2 `@dwk/server` replicas + an nginx proxy) and
   > `packages/server/k8s-notes.md` cover §14 item 4's packaging half;
   > `packages/server/src/migrate.ts` (the `dwk-migrate` bin) covers `dwk
   > migrate` (see the §13 update note above); `packages/server/README.md`'s
   > new "Central mode: horizontal scale-out (experimental)" section is the
   > "when not to use this mode" guidance, echoed with a one-line pointer
   > from the root `README.md`'s "Running it" section. What phase 5
   > explicitly does **not** close: the live-verification runs and the
   > hosted-suite conformance run against the compose reference (§14 items 4
   > and 5) — the runbook to execute them now exists
   > ([`conformance/scale-out-qa.md`](../conformance/scale-out-qa.md)), but
   > running it against real sqld/MinIO services is unfinished work, so
   > central mode remains **experimental, not supported** per host-contract
   > §9 until that runbook is recorded passing.
6. **v2 (separate decision, demand-gated)**: residency leases + internal
   forwarding (§6.5).

## 16. Open questions

1. **Package naming.** Scale-out makes `@dwk/server` depend on
   `@dwk/deno-host` — runtime-agnostic in fact, Deno-branded in name. Rename
   (e.g. `@dwk/central-shims`), extract a shared core, or live with the name?
   Nothing is stable-released yet, so a rename is still cheap; consuming
   as-is is the least work and the most misleading.
   > **Decided for #431: consume as-is.** `@dwk/server` now runtime-imports
   > `@dwk/deno-host` (`central-bindings.ts`) rather than only type-importing
   > it (#430's posture). A rename/extraction is still on the table and still
   > cheap pre-release, but re-litigating the package's name isn't this
   > issue's job and blocking Tier 1 on it serves nobody; revisit once a
   > second non-`@dwk/server` consumer (or the Deno Deploy Phase 1 build,
   > #396) makes the misleading name an actual cost rather than a
   > hypothetical one.
2. **The external-dependency thesis question**, third appearance
   ([portability.md §6](portability.md#6-open-questions),
   [deno-deploy-design.md §7](deno-deploy-design.md#7-open-questions)): sqld
   and MinIO are self-hostable containers, so scale-out can stay entirely on
   user-owned infrastructure — but the *operational* surface (running a SQL
   service and an object store) is real. Does the docs' answer differ for
   "managed Turso/S3" vs "sqld+MinIO in the same compose file"?
3. **Load-balancer affinity guarantees** vary by platform; how much WS-path
   affinity can the docs assume, and does the v1 stance on §6.4's lease/socket
   window need tightening for any real consumer before v2?
4. **D1 read latency** — every D1 query pays a network hop in central mode.
   Embedded replicas for D1 *reads* would break read-your-writes across
   replicas (contractually required), so the answer is likely "no, and hot
   read paths belong behind the (replica-local, stale-safe) KV cache" — worth
   confirming against microsub/mastodon-api timeline profiles.
5. **Coordination-KV growth** — expired-row sweep cadence and due-index
   backlog alarms need concrete thresholds once real traffic numbers exist
   (mirrors deno-host live-verification item 7).

## 17. Reference links

- [self-hosting.md](self-hosting.md) — the single-process container host this
  design extends; [host-contract.md](host-contract.md) — the normative bar;
  [portability.md](portability.md) — the container path this unlocks for
  disk-less platforms; [deno-deploy-design.md](deno-deploy-design.md) +
  [packages/deno-host.md](packages/deno-host.md) — the centralized-store
  shims this design reuses; [packages/cf-shims.md](packages/cf-shims.md) —
  the local-mode shims.
- [libSQL / sqld](https://github.com/tursodatabase/libsql) ·
  [Turso embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction) ·
  [`libsql` npm (sync embedded-replica client)](https://www.npmjs.com/package/libsql) ·
  [MinIO](https://min.io/) · [`aws4fetch`](https://github.com/mhart/aws4fetch)
- Prior art for the actor model: [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
  (the original), [Orleans virtual actors](https://learn.microsoft.com/en-us/dotnet/orleans/overview)
  (the §6.5 residency/forwarding shape).
