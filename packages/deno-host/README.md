# `@dwk/deno-host`

Deno Deploy host building blocks for the [`@dwk`
packages](https://github.com/davidwkeith/workers): external
[libSQL](https://github.com/tursodatabase/libsql)/[Turso](https://turso.tech)
presented behind the Cloudflare `D1Database` and `SqlStorage` (Durable Object
SQLite) interfaces from the
[host contract](../../spec/host-contract.md).

> **Status: exploratory/gated.** This package implements the SQL gap
> ([#397](https://github.com/davidwkeith/workers/issues/397)) and the
> single-writer actor + alarm emulation
> ([#398](https://github.com/davidwkeith/workers/issues/398), gate overridden
> on demonstrated demand) of the demand-gated `@dwk/deno-host` plan
> ([#396](https://github.com/davidwkeith/workers/issues/396), designed in
> [`spec/deno-deploy-design.md`](../../spec/deno-deploy-design.md)). The
> queue (#399) and object-storage (#400) gaps are not implemented yet, so this
> package cannot mount any endpoint package on its own — the queue gap is the
> remaining blocker.

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
`DurableObjectStorage`; the DO emulation layer (#398) embeds it in a
full `DurableObjectState`. `createSqlStorage` returns just the `sql` member
(e.g. for `@dwk/webdav`'s injected `LockStore`/`CredentialStore`).

## `createDurableObjectNamespace(ctor, options)` — host-contract §3.3

Single-writer actor + alarm emulation over a per-id Deno KV lease (issue
#398). `options` takes an injected `DenoKvLike` (a structural subset of
`Deno.Kv` — the package never constructs a connection itself), a
`getStorageClient(idHex)` factory returning the id's libSQL embedded-replica
client, and the composed `Env`.

```ts
import Database from "libsql";
import {
  createDurableObjectNamespace,
  DurableObject,
} from "@dwk/deno-host";

class PodObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    /* ... uses this.ctx.storage.sql / transactionSync / setAlarm ... */
  }
  async alarm(): Promise<void> {
    /* retry logic, same shape as the Cloudflare original */
  }
}

const POD = createDurableObjectNamespace(PodObject, {
  kv: await Deno.openKv(),
  className: "Pod",
  env,
  getStorageClient: (idHex) => {
    const db = new Database(`/tmp/pod-${idHex}.db`, {
      syncUrl: Deno.env.get("TURSO_DATABASE_URL")!,
      authToken: Deno.env.get("TURSO_AUTH_TOKEN")!,
    });
    db.sync();
    return db;
  },
});

// Wire to Deno.cron() — the package never starts its own timer.
Deno.cron("pod alarms", "* * * * *", () => POD.pollAlarms());
```

Per-id single-writer is enforced by a KV atomic-CAS lease, acquired once per
`fetch()`/`alarm()` delivery and released after (no renewal loop) — a
contended lease throws `LeaseContendedError` after a bounded retry, which
the composing app maps to a 503. Alarms are indexed directly in KV (not
inside the per-id SQLite file) so `pollAlarms()` can find due entries with
one range scan. WebSockets (`ctx.acceptWebSocket`/`getWebSockets`) are an
in-memory per-instance socket set, ported from `@dwk/cf-shims` — see
[`spec/packages/deno-host.md`](../../spec/packages/deno-host.md) for the
documented cross-process limitation on live sockets.

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
