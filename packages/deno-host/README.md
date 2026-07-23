# `@dwk/deno-host`

Deno Deploy host building blocks for the [`@dwk`
packages](https://github.com/davidwkeith/workers): external
[libSQL](https://github.com/tursodatabase/libsql)/[Turso](https://turso.tech)
presented behind the Cloudflare `D1Database` and `SqlStorage` (Durable Object
SQLite) interfaces from the
[host contract](../../spec/host-contract.md).

> **Status: exploratory/gated.** This package implements the SQL gap
> ([#397](https://github.com/davidwkeith/workers/issues/397)) of the
> demand-gated `@dwk/deno-host` plan
> ([#396](https://github.com/davidwkeith/workers/issues/396), designed in
> [`spec/deno-deploy-design.md`](../../spec/deno-deploy-design.md)). The
> actor/alarm (#398), queue (#399), and object-storage (#400) gaps are not
> implemented yet, so this package cannot mount any endpoint package on its
> own — it is the first, dependency-free increment of that plan.

## Why libSQL

Deno Deploy has no server-side SQLite-compatible store, and the `@dwk`
packages issue raw **SQLite**-dialect SQL (`PRAGMA table_info(...)`
migrations, `INSERT OR IGNORE`, `ON CONFLICT`) that the host contract says
must hit a real SQLite engine — a Postgres translation layer is
non-conforming. libSQL is a SQLite fork with a hosted/self-hostable server
(Turso), so it is the one external store that satisfies the dialect rule.

## What's here

Both shims take **injected client seams** — structural subsets of the real
libSQL client types — so this package has zero runtime dependencies and no
`node:`/Deno-specific imports; the composing app supplies the client.

### `createD1Database(client)` — host-contract §3.5

Wraps an **async remote libSQL client** (`@libsql/client`; use
`@libsql/client/web` on Deno Deploy) as a `D1Database`: one client — one
logical libSQL/Turso database — per D1 binding.

```ts
import { createClient } from "@libsql/client/web";
import { createD1Database } from "@dwk/deno-host";

const env = {
  DB: createD1Database(
    createClient({
      url: Deno.env.get("TURSO_DATABASE_URL")!,
      authToken: Deno.env.get("TURSO_AUTH_TOKEN")!,
    }),
  ),
};
```

`prepare`/`bind`/`first`/`all`/`run`/`batch`/`exec` (plus `raw`) are
provided with D1's `{ results, success, meta }` envelope; `meta.changes`
reports `rowsAffected`, and `batch` maps to `client.batch(stmts, "write")`,
which libSQL executes atomically and in order inside one implicit
transaction. `dump()` and `withSession()` are **not implemented** (they are
host-contract §7 non-requirements no `@dwk` package may call) — both throw
a clear "not implemented" error if invoked.

### `createDurableSqlite(db)` / `createSqlStorage(db)` — host-contract §3.2

The DO-SQLite surface is **synchronous** (`sql.exec(...).one()`,
`transactionSync(fn)`), which an async remote client cannot back. These
factories instead take libSQL's **synchronous embedded-replica client** (the
[`libsql`](https://www.npmjs.com/package/libsql) package's
better-sqlite3-compatible API): reads hit the instance-local replica file,
writes block until forwarded to the Turso primary — the exact semantics the
contract's "synchronous" wording encodes. Any better-sqlite3 or
`node:sqlite`-shaped handle also satisfies the seam.

```ts
import Database from "libsql";
import { createDurableSqlite } from "@dwk/deno-host";

const db = new Database("/tmp/pod-alice.db", {
  syncUrl: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN")!,
});
db.sync(); // catch the replica up before serving (re-run on lease acquisition)

const storage = createDurableSqlite(db); // { sql, transactionSync }
```

`createDurableSqlite` returns the `{ sql, transactionSync }` slice of
`DurableObjectStorage`; the DO emulation layer (#398) will embed it in a
full `DurableObjectState`. `createSqlStorage` returns just the `sql` member
(e.g. for `@dwk/webdav`'s injected `LockStore`/`CredentialStore`).

## What still needs live verification

The colocated tests drive both shims against a real SQLite engine through
the seams, but three claims depend on the real libSQL services and are
listed as explicit verification items in
[`spec/packages/deno-host.md`](../../spec/packages/deno-host.md):
read-your-writes at the primary for its own writer, `batch` atomicity over
hrana, and interactive-transaction write forwarding on embedded replicas.

## Spec

[`spec/packages/deno-host.md`](../../spec/packages/deno-host.md) —
authoritative requirements. Design context:
[`spec/deno-deploy-design.md`](../../spec/deno-deploy-design.md) §3.1,
[`spec/host-contract.md`](../../spec/host-contract.md) §3.2/§3.5/§4.
