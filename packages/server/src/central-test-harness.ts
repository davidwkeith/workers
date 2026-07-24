/**
 * Test doubles for the `central`-mode client seams, shared by
 * `central-bindings.test.ts`, `central-mode.test.ts`, and
 * `central.integration.test.ts`.
 *
 * Same posture as `@dwk/deno-host`'s own (unpublished) test harness: these
 * reproduce the documented client behaviors the shims depend on — `batch` as
 * one transaction, `rowsAffected` on writes, S3's header case-folding — not a
 * mock that always succeeds. Not re-exported from the package's public
 * surface; excluded from the published build (see `tsconfig.build.json`).
 */

import { DatabaseSync } from "node:sqlite";
import type {
  LibsqlClientLike,
  LibsqlResultSetLike,
  LibsqlStatementLike,
  LibsqlTransactionMode,
  S3ClientLike,
  SqlValue,
} from "@dwk/deno-host";
import type { EmbeddedReplicaClientLike } from "./central-durable-object.js";

const WRITE_RE = /^\s*(insert|update|delete|replace)\b/i;

/** An async `LibsqlClientLike` over an in-memory `node:sqlite` database. */
export function createFakeLibsqlClient(
  db = new DatabaseSync(":memory:"),
): LibsqlClientLike & { readonly db: DatabaseSync } {
  function executeSync(stmt: LibsqlStatementLike): LibsqlResultSetLike {
    const rows = db.prepare(stmt.sql).all(...stmt.args) as Record<
      string,
      unknown
    >[];
    const first = rows[0];
    const changes = db.prepare("SELECT changes() AS c").get() as {
      c: number;
    };
    return {
      columns: first ? Object.keys(first) : [],
      rows,
      rowsAffected: WRITE_RE.test(stmt.sql) ? Number(changes.c) : 0,
      lastInsertRowid: undefined,
    };
  }
  return {
    db,
    async execute(stmt) {
      return executeSync(stmt);
    },
    async batch(stmts, mode: LibsqlTransactionMode = "deferred") {
      db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const out = stmts.map(executeSync);
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async executeMultiple(sql) {
      db.exec(sql);
    },
  };
}

interface FakeS3Object {
  readonly bytes: Uint8Array;
  readonly headers: Record<string, string>;
}

/**
 * An in-memory `S3ClientLike` reproducing the slice of the S3 REST API
 * `@dwk/deno-host`'s `r2.ts` shim depends on: `PUT`/`GET`/`HEAD`/`DELETE`,
 * header storage, a minted `ETag` per `PUT`, and a `404` for a missing key.
 * `DELETE` is idempotent, matching host-contract §3.4.
 */
export class FakeS3Client implements S3ClientLike {
  readonly #store = new Map<string, FakeS3Object>();

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const path = new URL(input.toString()).pathname;
    const method = (init.method ?? "GET").toUpperCase();

    if (method === "PUT") {
      const bytes = new Uint8Array(
        await new Response(init.body as BodyInit | null).arrayBuffer(),
      );
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      headers["etag"] = crypto.randomUUID();
      this.#store.set(path, { bytes, headers });
      return new Response(null, {
        status: 200,
        headers: { etag: `"${headers["etag"]}"` },
      });
    }

    const object = this.#store.get(path);
    if (method === "DELETE") {
      this.#store.delete(path);
      return new Response(null, { status: 204 });
    }
    if (object === undefined) return new Response(null, { status: 404 });

    const headers = new Headers();
    if (object.headers["content-type"]) {
      headers.set("content-type", object.headers["content-type"]);
    }
    headers.set("content-length", String(object.bytes.byteLength));
    headers.set("etag", `"${object.headers["etag"] ?? "0"}"`);
    headers.set("last-modified", new Date(0).toUTCString());
    for (const [name, value] of Object.entries(object.headers)) {
      if (name.startsWith("x-amz-meta-")) headers.set(name, value);
    }

    if (method === "HEAD") return new Response(null, { status: 200, headers });
    if (method === "GET")
      return new Response(object.bytes, { status: 200, headers });
    throw new Error(`FakeS3Client: unsupported method ${method}`);
  }
}

/* ---------- fake embedded-replica client (central DO storage, #432) ---------- */

const WRITE_OR_DDL_RE =
  /^\s*(insert|update|delete|replace|create|alter|drop|pragma)\b/i;

/**
 * Full-refresh "sync": drop and recreate every table on `local` from
 * `primary`'s current schema and rows. A real libSQL embedded replica syncs
 * incrementally over WAL frames; this fake reproduces the *observable*
 * contract (after `sync()`, `local` reads see everything committed to
 * `primary`) without needing a real libSQL server, which is exactly the
 * property `sync-before-serve` regression tests depend on.
 */
function fullSync(primary: DatabaseSync, local: DatabaseSync): void {
  const tables = primary
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string; sql: string }[];
  for (const table of tables) {
    local.exec(`DROP TABLE IF EXISTS "${table.name}"`);
    local.exec(table.sql);
    const rows = primary
      .prepare(`SELECT * FROM "${table.name}"`)
      .all() as Record<string, unknown>[];
    const first = rows[0];
    if (first === undefined) continue;
    const columns = Object.keys(first);
    const insert = local.prepare(
      `INSERT INTO "${table.name}" (${columns.map((c) => `"${c}"`).join(", ")}) ` +
        `VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows) {
      insert.run(...columns.map((c) => row[c] as never));
    }
  }
}

/**
 * A fake {@link EmbeddedReplicaClientLike}: a local `:memory:` `node:sqlite`
 * database plus a shared "primary" `node:sqlite` database representing the
 * libSQL primary. Writes (sniffed by a leading-keyword regex, the same
 * approach `createFakeLibsqlClient` above uses) execute against **both** —
 * modeling a real embedded replica's "writes forward to the primary and are
 * reflected locally without needing a sync" behavior — while reads and
 * `sync()` only ever touch `local`, so another replica's write is invisible
 * here until `sync()` runs. This is the fake `central-durable-object.test.ts`
 * and the multi-replica integration suite drive instead of a live libSQL
 * server (see `libsql-native.smoke.test.ts` for the one real-`libsql`
 * native-module check).
 */
class FakeEmbeddedReplicaClient implements EmbeddedReplicaClientLike {
  readonly #local = new DatabaseSync(":memory:");
  readonly #primary: DatabaseSync;

  constructor(primary: DatabaseSync) {
    this.#primary = primary;
  }

  exec(sql: string): unknown {
    this.#local.exec(sql);
    this.#primary.exec(sql);
    return undefined;
  }

  prepare(sql: string) {
    const isWrite = WRITE_OR_DDL_RE.test(sql);
    return {
      all: (...args: SqlValue[]): unknown[] => {
        if (isWrite) this.#primary.prepare(sql).run(...args);
        return this.#local.prepare(sql).all(...args);
      },
      run: (...args: SqlValue[]): { changes: number | bigint } => {
        if (isWrite) this.#primary.prepare(sql).run(...args);
        return this.#local.prepare(sql).run(...args);
      },
    };
  }

  async sync(): Promise<void> {
    fullSync(this.#primary, this.#local);
  }
}

/**
 * Shared per-id "primary" store for {@link createFakeEmbeddedReplicaFactory}:
 * pass the **same** instance to every simulated replica's factory so their
 * fake clients converge on one source of truth per object id, exactly as
 * real replicas converge on one libSQL primary per id.
 */
export function createFakeEmbeddedReplicaPrimaries(): Map<
  string,
  DatabaseSync
> {
  return new Map();
}

/**
 * Build a `getStorageClient(idHex)` factory for one simulated replica: each
 * call returns a **fresh** local database (a new, unsynced replica file) for
 * that id, backed by the shared `primaries` map's database for that id
 * (created on first reference by any replica).
 */
export function createFakeEmbeddedReplicaFactory(
  primaries: Map<string, DatabaseSync>,
): (idHex: string) => EmbeddedReplicaClientLike {
  return (idHex: string): EmbeddedReplicaClientLike => {
    let primary = primaries.get(idHex);
    if (primary === undefined) {
      primary = new DatabaseSync(":memory:");
      primaries.set(idHex, primary);
    }
    return new FakeEmbeddedReplicaClient(primary);
  };
}
