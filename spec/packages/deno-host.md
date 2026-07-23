# `@dwk/deno-host`

| | |
|---|---|
| **Type** | lib (Deno Deploy host building blocks, Cloudflare-interface emulation) |
| **Ships a DO?** | no (emulates one in-process via `createDurableObjectNamespace` — #398) |
| **Used by** | nothing yet (a future composed Deno Deploy app is the intended consumer) |

Deno Deploy host building blocks for the `@dwk` packages: external
libSQL/Turso presented behind the Cloudflare `D1Database` and `SqlStorage`
(Durable Object SQLite) interfaces defined by
[host-contract.md](../host-contract.md). This is the Deno Deploy analog of
[`@dwk/cf-shims`](cf-shims.md) — like it, the package's entire purpose is
Cloudflare-interface emulation, so it is deliberately Cloudflare-shaped;
unlike it, the implementation is **runtime-agnostic** (no `node:` imports,
no Deno globals) and reaches its backing store only through injected client
seams.

> **Status: exploratory/gated.** Implements the SQL gap (issue #397) and the
> single-writer actor + alarm emulation (issue #398, gate overridden on
> demonstrated demand — see
> [below](#design-single-writer-actor--alarm-emulation-issue-398)) of the
> demand-gated `@dwk/deno-host` plan (#396;
> [deno-deploy-design.md](../deno-deploy-design.md) §3.1, §3.2). The
> KV-backed queue (#399) and the `R2Bucket` object-storage adapter (#400)
> are **not** implemented, so no endpoint package can mount on this host
> yet — per
> [deno-deploy-design.md §6](../deno-deploy-design.md#6-decision-gate) even
> Tier 1 ([host-contract.md §9](../host-contract.md#9-conformance-tiers-and-how-a-host-proves-compliance))
> needs the queue gap closed first. #399/#400 stay demand-gated.

## Why libSQL (and not Postgres, KV, or local disk)

Deno Deploy has no server-side SQLite-compatible relational store
([deno-deploy-design.md §1](../deno-deploy-design.md#1-re-verification-2026-07-23-snapshot)).
The packages issue raw **SQLite**-dialect SQL — `PRAGMA table_info(...)`
migrations, `INSERT OR IGNORE`, `ON CONFLICT` — and host-contract §3.2/§3.5
require a real SQLite engine, treating a dialect-translation layer as
non-conforming, which rules out the platform's Postgres providers. Local
disk is ruled out because the platform runs multiple isolated instances per
app with no shared persistent volume. libSQL is a SQLite fork with a
hosted/self-hostable server (Turso), satisfying the dialect rule with an
external, strongly-consistent store.

## Functional requirements

### Client seams (no runtime dependencies)

The shims MUST NOT construct connections or read the environment; the
composing app injects a client. Two structural seams, each a subset of the
corresponding real libSQL client type so real instances are assignable
unmodified:

- **`LibsqlClientLike`** — the async remote client (`@libsql/client` /
  `@libsql/client/web`): `execute({sql, args})`, `batch(stmts, mode?)`,
  `executeMultiple(sql)`, returning `{ columns, rows, rowsAffected,
  lastInsertRowid }` result sets. `batch` MUST execute in one implicit
  transaction, in order, all-or-nothing (the `@libsql/client` contract).
- **`SyncSqliteDatabaseLike`** — the synchronous embedded-replica client
  (the `libsql` npm package's better-sqlite3-compatible API):
  `exec(sql)` and `prepare(sql)` → `{ reader?, all(...args), run(...args) }`.
  When a driver exposes `reader: false` (better-sqlite3-family statements
  throw from `all()` on non-reader statements), writes are routed through
  `run()`; drivers without `reader` metadata (`node:sqlite`) get every
  statement through `all()`.

Bind values are normalized as Cloudflare does: booleans → 0/1,
`undefined` → NULL, `ArrayBuffer` → byte blob; anything not
`null | number | bigint | string | Uint8Array` is a `TypeError`.

### `createD1Database(client)` — host-contract §3.5

`D1Database` over the async seam, one client (one logical libSQL/Turso
database) per binding:

- `prepare(sql).bind(...)` positional (including SQLite's `?N` numbered
  form, which libSQL binds positionally), `.first(colName?)` /
  `.all()` / `.run()` / `.raw()` with D1's `{ results, success, meta }`
  envelope; **`meta.changes`** MUST come from the client's `rowsAffected`
  (the `INSERT OR IGNORE` dedup / conditional-update branch), and
  `meta.last_row_id` from `lastInsertRowid`.
- Result rows MUST be plain objects keyed by column name, in column order —
  the client's array-like hybrid `Row` objects MUST NOT leak to package
  code.
- `batch(stmts)` maps to `client.batch(stmts, "write")` — atomic and
  in-order per the seam contract — returning one envelope per statement,
  each with its own `meta.changes`. Statements from a foreign `prepare()`
  are a `TypeError`.
- `exec(sql)` maps to `client.executeMultiple`, reporting D1's
  `{ count, duration }`; the statement count strips string/comment literals
  first so a `;` inside a literal is not counted.
- Not implemented (host-contract §7 non-requirements production packages
  MUST NOT call): `dump()` and `withSession()` — both are present but fail
  loudly with a clear "not implemented" error rather than crashing on an
  undefined member. `raw()` **is** implemented, as in `@dwk/cf-shims`.

### `createSqlStorage(db)` / `createDurableSqlite(db)` — host-contract §3.2

The synchronous DO-SQLite surface over the sync seam:

- `sql.exec<T>(query, ...bindings)` executes one statement synchronously
  and returns a one-shot cursor: `.one()` (throws unless exactly one row),
  `.toArray()` (drains remaining rows), `.next()` / `for…of` iteration,
  `columnNames`. Prepared statements are cached per query string. Known
  fidelity gap (shared with `@dwk/cf-shims`, harmless — no production
  package reads `columnNames`): the seam carries no column metadata
  independent of rows, so a zero-row result reports `columnNames: []`
  where Cloudflare's real cursor still knows the query's columns.
- `createDurableSqlite(db)` returns the `{ sql, transactionSync }` slice of
  `DurableObjectStorage`: `transactionSync(fn)` commits on return and rolls
  back **entirely** when `fn` throws (the atomicity `@dwk/store`,
  `solid-pod`, and `atproto-pds` depend on). Nesting is unsupported
  (matching Cloudflare and `@dwk/cf-shims`) and MUST fail loudly: a nested
  call throws a clear error instead of letting the inner `BEGIN`/`ROLLBACK`
  corrupt the outer transaction. The full `DurableObjectState` (alarms,
  WebSockets, per-id lease) is #398's job and will embed this.
- `createSqlStorage(db)` returns just the `sql` member, for consumers that
  take an injected `SqlStorage` (`@dwk/webdav`'s `LockStore` /
  `CredentialStore`).

### The synchronous gap (resolved design decision)

Host-contract §3.2's surface is synchronous; an async remote client cannot
back it — there is no way to return rows synchronously from a promise, so
issue #397's original "queued/awaited wrapper" sketch is **not
implementable** for `SqlStorage` (it does work for `D1Database`, whose
surface is async). The resolution is libSQL's **embedded replica** sync
client: the per-object database lives at the Turso primary, each serving
instance keeps a local replica file (per-instance scratch disk suffices —
the replica is a cache, re-synced from the primary on startup/lease
acquisition), reads are local and synchronous, and writes block the calling
thread while forwarded to the primary. That blocking is precisely what the
contract's "synchronous" wording encodes ("the whole DO event loop blocks
until commit"), so no host-contract text change is needed — this resolves
the "flag against the contract text" question the issue left open.

## Design: single-writer actor + alarm emulation (issue #398)

> **Status: implemented.** Approved 2026-07-23 via the brainstorming
> process on a demonstrated demand signal that overrode the demand gate for
> this increment only — #399 (queues) and #400 (object storage) stay
> gated. See [issue #398](https://github.com/davidwkeith/workers/issues/398)
> and
> [deno-deploy-design.md §3.2](../deno-deploy-design.md#32-single-writer-actor-durable-objects-host-contract-33).

### New client seam: `DenoKvLike`

Mirrors #397's injected-client pattern (`LibsqlClientLike`): the package
never constructs a `Deno.Kv` connection itself — the composing app injects
one. A structural subset of `Deno.Kv`, so a real instance is assignable
unmodified:

```ts
export interface DenoKvEntryLike<T = unknown> {
  key: readonly unknown[];
  value: T;
  versionstamp: string | null;
}
export interface DenoKvCheckLike {
  key: readonly unknown[];
  versionstamp: string | null;
}
export interface DenoKvAtomicLike {
  check(...checks: DenoKvCheckLike[]): DenoKvAtomicLike;
  set(
    key: readonly unknown[],
    value: unknown,
    options?: { expireIn?: number },
  ): DenoKvAtomicLike;
  delete(key: readonly unknown[]): DenoKvAtomicLike;
  commit(): Promise<{ ok: boolean; versionstamp?: string }>;
}
export interface DenoKvLike {
  get<T = unknown>(key: readonly unknown[]): Promise<DenoKvEntryLike<T>>;
  set(
    key: readonly unknown[],
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<{ versionstamp: string }>;
  delete(key: readonly unknown[]): Promise<void>;
  list<T = unknown>(
    selector: {
      prefix: readonly unknown[];
      start?: readonly unknown[];
      end?: readonly unknown[];
    },
    options?: { limit?: number },
  ): AsyncIterableIterator<DenoKvEntryLike<T>>;
  atomic(): DenoKvAtomicLike;
}
```

### Lease (`lease.ts`) — host-contract §3.3 rule 1

Key: `["dwk_lease", className, idHex]`.

- **Acquire**: `kv.atomic().check({key, versionstamp: null}).set(key,
  {holder}, {expireIn: leaseTtlMs}).commit()` — succeeds only when nobody
  currently holds the key. `expireIn` is a crash safety net: a holder that
  dies mid-request without releasing still frees the lease after
  `leaseTtlMs` (default well above expected p99 request latency, e.g.
  30000ms — configurable via `DurableObjectNamespaceOptions.leaseTtlMs`).
- **Contention**: on a failed acquire, retry with exponential backoff
  (starting ~50ms, capped) until `leaseAcquireTimeoutMs` elapses (default
  e.g. 5000ms), then throw `LeaseContendedError`. The composing app maps
  this to a 503 — the shim does not retry past the timeout; there is no
  unbounded wait.
- **Release**: `kv.atomic().check({key, versionstamp: <versionstamp from
  acquire>}).delete(key).commit()`. A versionstamp mismatch (the lease
  already expired and a different holder acquired it) makes release a
  no-op instead of deleting another holder's lease.
- **Scope**: acquired once per `fetch()`/`alarm()` delivery, released in a
  `finally` after the delivery completes — no renewal loop. Within one
  process, a local per-id promise chain (ported from `@dwk/cf-shims`'
  `ShimDurableObjectNamespace`) still serializes concurrent same-id
  deliveries; the KV round-trip is what enforces the guarantee *across*
  processes, not the only thing enforcing order *within* one.

### Alarms (`alarms.ts`) — host-contract §3.3 rule 2

Unlike `@dwk/cf-shims` (which persists the alarm inside the object's own
SQLite file and recovers by scanning local files on startup — viable only
because the Node host is one process with a shared filesystem), alarms here
are indexed **directly in KV** so a poll can find due entries without
opening every object's database:

- `["dwk_alarm_due", className, epochMs, idHex]` → `idHex` — the ordered
  index a poll range-scans (`Deno.Kv` orders numeric key parts
  numerically).
- `["dwk_alarm_by_id", className, idHex]` → `epochMs` — the current
  scheduled time; `setAlarm` reads this first to atomically remove the old
  due-index entry before writing the new one (single-slot: a later call
  replaces, per host-contract).

`setAlarm(idHex, epochMs)` / `getAlarm(idHex)` / `deleteAlarm(idHex)` wrap
these two keys behind one atomic KV transaction each.

`pollAlarms(namespace, { now, batchSize? })` is the exported tick function a
composing app wires to whatever periodic trigger its runtime offers
(`Deno.cron()` on Deno Deploy) — the package itself never starts a timer:

1. Range-scan `["dwk_alarm_due", className]` up to `["dwk_alarm_due",
   className, now]`, up to `batchSize` entries (default e.g. 100).
2. For each due entry, atomically claim it — `check` its versionstamp and
   `delete` it in one atomic op — so two overlapping polls (e.g. during an
   instance handoff) cannot both fire the same alarm. A claim that loses the
   race is simply skipped.
3. Dispatch through the same lease-acquire + local-chain path as `fetch`,
   then call the object's `alarm()`. Step 2's claim already gives
   persisted-time-is-source-of-truth and delete-before-run semantics.
4. On a throwing handler: **write a new due-index entry at `now +
   backoffMs(retryCount)`** (exponential, same default schedule as
   `@dwk/cf-shims`: base 2s, up to 6 retries) instead of an in-process
   timer — the process running this poll is not guaranteed to be the one
   that runs the next tick, so the retry must be discoverable by any
   instance. A handler that sets a new alarm during its own run supersedes
   the retry (checked before writing the retry entry).

### `createDurableObjectNamespace` (`durable-object.ts`) — ties it together

```ts
export interface DurableObjectNamespaceOptions<Env> {
  readonly kv: DenoKvLike;
  readonly className: string;
  readonly env: Env;
  /** Per-id libSQL embedded-replica client; called once per id, cached for
   *  the process's lifetime alongside the constructed instance. */
  readonly getStorageClient: (idHex: string) => SyncSqliteDatabaseLike;
  readonly leaseTtlMs?: number;
  readonly leaseAcquireTimeoutMs?: number;
}
export function createDurableObjectNamespace<
  Env,
  T extends { fetch(r: Request): Promise<Response> },
>(
  ctor: DurableObjectClass<T>,
  options: DurableObjectNamespaceOptions<Env>,
): DurableObjectNamespaceLike<T>;
```

(`DurableObjectNamespaceLike<T>` is this design's namespace surface: `get(id)`,
`idFromName`/`idFromString`/`newUniqueId`, matching `@dwk/cf-shims`'
`ShimDurableObjectNamespace` shape minus its file-based persistence.)

- `idFromName(name)` / `idFromString(hex)` / `newUniqueId()`: same shape as
  `@dwk/cf-shims`, but the hash backing `idFromName` must be **synchronous**
  (real Cloudflare `idFromName` is sync, and so is `@dwk/cf-shims`'), and
  `crypto.subtle.digest` is async-only — so this package implements a
  small, dependency-free synchronous hash purely for stable id derivation.
  No cryptographic requirement; same rationale `@dwk/cf-shims` had for using
  sha256 (distribution/stability, not security).
- `get(id)` returns a `{ fetch(request) }` stub. Dispatch: acquire the id's
  lease → run through the process-local per-id chain + a
  `blockConcurrencyWhile` gate (ported from `@dwk/cf-shims`) → construct or
  reuse the cached `DurableObject` instance (construction calls
  `getStorageClient(idHex)` once and wraps it via #397's
  `createDurableSqlite`) → `object.fetch(request)` → release the lease in
  `finally`.
- `DurableObject<Env>` base class re-exported, matching `@dwk/cf-shims`'
  shape (`ctx`/`env` fields, optional `alarm()` override). The composing
  Deno app aliases the `cloudflare:workers` bare specifier to this export
  via its `deno.json` `imports` map — the Deno-native equivalent of
  `@dwk/cf-shims`' Node `module.register` loader hook.

### WebSocket support (host-contract §3.3 rule 3)

`ctx.acceptWebSocket(ws)` / `ctx.getWebSockets()`: an in-memory
`Set<WebSocket>` per resident instance, with the same event-listener-based
dispatch to `webSocketMessage`/`webSocketClose`/`webSocketError` overrides
as `@dwk/cf-shims`' `ShimDurableObjectState`. This part is already
runtime-agnostic (standard `WebSocket` events), so it ports without change.

**Known limitation, documented rather than glossed over:** the per-request
KV lease governs `fetch`/`alarm` delivery, but a live socket's
`message`/`close` events are inherently pinned to whichever process
terminated the upgrade — they do not re-acquire the lease per event. If a
different process later holds the lease for the same id (e.g. this
process's most recent per-request lease expired) while a socket stays open
here, host-contract's "single-threaded execution... across fetch/alarm/socket"
is not fully cross-process-enforced for the socket path. This mirrors
[deno-deploy-design.md §3.2](../deno-deploy-design.md#32-single-writer-actor-durable-objects-host-contract-33)'s
own hedge that WebSockets are "layered on top of whichever instance holds
the lease" without a deeper resolution; a future increment could tighten
this (e.g. a longer-held "socket session" lease) if it becomes a real
correctness problem for a production consumer.

### Consistency (host-contract §4 addendum)

| Contract requirement | How this design meets it |
| --- | --- |
| DO: per-id single writer | KV lease (CAS, `expireIn` crash safety net) + process-local per-id chain |
| DO: durable, single-slot alarms with retry | KV-indexed due/by-id keys; `pollAlarms` claim-then-dispatch; retry via a new due-index entry, not an in-process timer |
| DO: hibernatable-style WebSockets | In-memory per-instance socket set (see limitation above) |

### Testing plan (#398)

`test-harness.ts` gains a `DenoKvLike` fake: an in-memory `Map` keyed by a
stable serialization of the key array, a monotonic versionstamp counter, and
real CAS semantics in `atomic().commit()` — same posture as #397's
`node:sqlite`-backed libSQL fakes (reproduce documented behavior, not a
mock that always succeeds). New colocated tests:

- Lease: acquire/release round-trip; contention (two acquires racing the
  same key, one wins); timeout-then-`LeaseContendedError`; release-after-
  expiry is a no-op (doesn't delete a new holder's lease).
- Alarms: schedule/fire; retry-on-throw writes a new due entry rather than
  firing again immediately; a handler that sets a new alarm supersedes the
  pending retry; two concurrent `pollAlarms` calls racing the same due entry
  fire it only once.
- Namespace integration: two "processes" sharing one fake `DenoKvLike`
  simulate cross-process single-writer enforcement (a second dispatch for
  the same id blocks/fails while the first holds the lease); storage wiring
  via `getStorageClient` + `createDurableSqlite` round-trips a write across
  dispatches for the same id.
- WebSocket: accept/dispatch to `webSocketMessage`/`webSocketClose`
  overrides, matching `@dwk/cf-shims`' existing coverage shape.

## Consistency (host-contract §4)

| Contract requirement | How this design meets it |
| --- | --- |
| D1: read-your-writes | libSQL at the primary is read-your-writes for its own writer; every D1 call goes to the primary. |
| D1: atomic `batch` | `client.batch(..., "write")` is one implicit transaction. |
| DO SQLite: `transactionSync` atomicity | SQLite transaction on the sync client; BEGIN/COMMIT/ROLLBACK. |
| DO SQLite: serialized per id | Out of scope here — #398's per-id lease provides it; these shims assume a single writer per database. |

## Live verification required before any host claim

The colocated tests drive both shims against a real SQLite engine
(`node:sqlite`) through the seams, verifying shim semantics — but three
claims depend on the real libSQL services and MUST be verified against a
live Turso/libSQL deployment before this package is documented as part of a
**supported** host (host-contract §9), per #397's "verify this explicitly
rather than assuming it":

1. **Read-your-writes at the primary for its own writer** over the hrana
   protocol (`@libsql/client/web`), including across sequential `execute`
   calls on one client.
2. **`batch` atomicity/in-order execution** over hrana under a mid-batch
   constraint failure.
3. **Embedded-replica write forwarding inside interactive transactions** —
   `transactionSync` issues BEGIN/COMMIT through the sync client; confirm
   the `libsql` package forwards the whole transaction to the primary
   atomically (and whether the `libsql` native module loads on the current
   Deno Deploy platform at all).

Addendum for #398, once implemented:

4. **`Deno.Kv` atomic CAS semantics** under real contention (two Deploy
   instances racing the same key) — the test-harness fake proves the
   *documented* behavior, not the platform's actual behavior under
   concurrent access from separate isolates.
5. **`expireIn` TTL precision and `list()` key-ordering** for numeric key
   parts — the alarm due-index scan depends on `epochMs` sorting
   numerically, not lexicographically as a naive string encoding would.
6. **Cron tick granularity** on the new Deno Deploy platform (flagged as
   undocumented in
   [deno-deploy-design.md §7](../deno-deploy-design.md#7-open-questions)) —
   directly determines alarm delivery latency for whatever `pollAlarms`
   interval the composing app's `Deno.cron()` uses.

Also still open (unchanged from
[deno-deploy-design.md §7](../deno-deploy-design.md#7-open-questions)):
whether an external libSQL/Turso dependency is acceptable against the
project's "infrastructure the user owns" thesis. Building this shim does
not resolve that question; it makes the trade concrete.

## Test environment

Node (`environment: "node"`), no Miniflare. The seams are driven by
`node:sqlite`-backed fakes in `src/test-harness.ts`: an async
`LibsqlClientLike` fake reproducing libSQL's documented behaviors
(positional `?N` binding, `rowsAffected`, array-like hybrid rows,
transactional `batch`) and a strict better-sqlite3-style sync driver
(`reader` metadata, `all()` throwing on writes).

## Non-goals (tracked separately)

- Durable at-least-once queue emulation on Deno KV — #399.
- `R2Bucket`-shaped adapter over an S3-compatible store — #400.
- Any commitment to proceed with #399/#400: the decision gate in
  [deno-deploy-design.md §6](../deno-deploy-design.md#6-decision-gate)
  still holds for the remainder of the plan; only #398 was greenlit, on a
  demonstrated demand signal specific to it.

## Reference links

- [deno-deploy-design.md](../deno-deploy-design.md) — the re-verification
  and design sketch this implements (§3.1 for the SQL shims, §3.2 for the
  #398 actor/alarm design above);
  [host-contract.md](../host-contract.md) — the normative contract
  (§3.2, §3.5, §4); [portability.md](../portability.md) §5 —
  the demand-gated Phase 1 this belongs to; [cf-shims.md](cf-shims.md) —
  the Node-host precedent.
- [`@libsql/client` docs](https://docs.turso.tech/sdk/ts/reference) ·
  [`libsql` (embedded replica) package](https://www.npmjs.com/package/libsql) ·
  [D1 client API](https://developers.cloudflare.com/d1/worker-api/) ·
  [DO SQL storage](https://developers.cloudflare.com/durable-objects/api/sql-storage/)
