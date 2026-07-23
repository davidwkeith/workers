# `@dwk/deno-host`

| | |
|---|---|
| **Type** | lib (Deno Deploy host building blocks, Cloudflare-interface emulation) |
| **Ships a DO?** | no (will emulate one — #398, not yet implemented) |
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

> **Status: exploratory/gated.** Implements the SQL gap (issue #397) of the
> demand-gated `@dwk/deno-host` plan (#396;
> [deno-deploy-design.md](../deno-deploy-design.md) §3.1). The single-writer
> actor + alarm emulation (#398), the KV-backed queue (#399), and the
> `R2Bucket` object-storage adapter (#400) are **not** implemented, so no
> endpoint package can mount on this host yet — per
> [deno-deploy-design.md §6](../deno-deploy-design.md#6-decision-gate) even
> Tier 1 ([host-contract.md §9](../host-contract.md#9-conformance-tiers-and-how-a-host-proves-compliance))
> needs the queue gap closed first. The rest of the plan stays demand-gated.

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
  `{ count, duration }`.

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

- Single-writer actor + alarm emulation via a Deno KV lease — #398.
- Durable at-least-once queue emulation on Deno KV — #399.
- `R2Bucket`-shaped adapter over an S3-compatible store — #400.
- Any commitment to proceed with those: the decision gate in
  [deno-deploy-design.md §6](../deno-deploy-design.md#6-decision-gate)
  still holds for the remainder of the plan.

## Reference links

- [deno-deploy-design.md](../deno-deploy-design.md) — the re-verification
  and design sketch this implements (§3.1);
  [host-contract.md](../host-contract.md) — the normative contract
  (§3.2, §3.5, §4); [portability.md](../portability.md) §5 —
  the demand-gated Phase 1 this belongs to; [cf-shims.md](cf-shims.md) —
  the Node-host precedent.
- [`@libsql/client` docs](https://docs.turso.tech/sdk/ts/reference) ·
  [`libsql` (embedded replica) package](https://www.npmjs.com/package/libsql) ·
  [D1 client API](https://developers.cloudflare.com/d1/worker-api/) ·
  [DO SQL storage](https://developers.cloudflare.com/durable-objects/api/sql-storage/)
