/**
 * Test doubles for the two client seams, backed by `node:sqlite`.
 *
 * `createFakeLibsqlClient` emulates the documented `@libsql/client`
 * semantics the D1 shim depends on: positional args (including SQLite's
 * `?N` numbered form, which `node:sqlite` binds differently and must be
 * mapped), `rowsAffected`/`lastInsertRowid` on writes, array-like hybrid
 * rows (name + index keys, so the shim's plain-object copying is actually
 * exercised), and `batch` running inside one implicit transaction.
 *
 * `createStrictSyncSqlite` wraps `node:sqlite` in the better-sqlite3 /
 * `libsql` statement contract — `reader` exposed, `all()` throwing on
 * non-reader statements — so the SqlStorage shim's write path is exercised
 * the way the real embedded-replica client would exercise it. (A bare
 * `DatabaseSync` also satisfies `SyncSqliteDatabaseLike`, covering the
 * no-`reader` driver flavor.)
 *
 * Excluded from the published build; tests only.
 */

import { DatabaseSync } from "node:sqlite";
import {
  SQL_STRIP_RE,
  type LibsqlClientLike,
  type LibsqlResultSetLike,
  type LibsqlStatementLike,
  type LibsqlTransactionMode,
  type SqlValue,
  type SyncSqliteDatabaseLike,
  type SyncSqliteStatementLike,
} from "./client.js";

/** Matches SQLite's numbered placeholder form (`?1`, `?2`, ...). */
const NUMBERED_PLACEHOLDER = /\?\d+/;

/**
 * `node:sqlite` binds `?N` placeholders from an object keyed by placeholder
 * number, not positionally; libSQL binds them positionally like SQLite
 * proper. Map to the object form so the fake matches libSQL's behavior.
 */
function bindArgs(sql: string, params: SqlValue[]): SqlValue[] {
  if (!NUMBERED_PLACEHOLDER.test(sql.replace(SQL_STRIP_RE, ""))) return params;
  const named: Record<string, SqlValue> = {};
  params.forEach((value, index) => {
    named[`?${index + 1}`] = value;
  });
  return [named] as unknown as SqlValue[];
}

const WRITE_RE = /^\s*(insert|update|delete|replace)\b/i;

/**
 * Build an `@libsql/client`-style array-like hybrid row: columns readable by
 * name *and* by numeric index. The D1 shim must copy these into plain
 * objects; handing the hybrid straight through would leak numeric keys.
 */
function toHybridRow(
  columns: string[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const hybrid: Record<string, unknown> = { length: columns.length };
  columns.forEach((column, index) => {
    hybrid[column] = row[column];
    hybrid[index] = row[column];
  });
  return hybrid;
}

export interface FakeLibsqlClient extends LibsqlClientLike {
  /** The backing connection, for test-side assertions. */
  readonly db: DatabaseSync;
}

/** An async `LibsqlClientLike` over an in-memory `node:sqlite` database. */
export function createFakeLibsqlClient(
  db = new DatabaseSync(":memory:"),
): FakeLibsqlClient {
  function executeSync(stmt: LibsqlStatementLike): LibsqlResultSetLike {
    const prepared = db.prepare(stmt.sql);
    const rows = prepared.all(...bindArgs(stmt.sql, stmt.args)) as Record<
      string,
      unknown
    >[];
    const columns = rows[0] ? Object.keys(rows[0]) : [];
    const isWrite = WRITE_RE.test(stmt.sql);
    const changes = db.prepare("SELECT changes() AS c").get() as {
      c: number | bigint;
    };
    const rowId = db.prepare("SELECT last_insert_rowid() AS r").get() as {
      r: number | bigint;
    };
    return {
      columns,
      rows: rows.map((row) => toHybridRow(columns, row)),
      rowsAffected: isWrite ? Number(changes.c) : 0,
      lastInsertRowid: isWrite ? BigInt(rowId.r) : undefined,
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

/**
 * A `SyncSqliteDatabaseLike` enforcing the better-sqlite3 / `libsql`
 * statement contract over `node:sqlite`: `reader` is exposed, and `all()`
 * throws on statements that return no rows.
 */
export function createStrictSyncSqlite(
  db = new DatabaseSync(":memory:"),
): SyncSqliteDatabaseLike & { readonly db: DatabaseSync } {
  return {
    db,
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string): SyncSqliteStatementLike {
      const stmt = db.prepare(sql);
      // Mirror better-sqlite3's `reader` heuristic closely enough for tests:
      // a statement is a reader when SQLite reports result columns. Writes
      // with RETURNING are readers there too, and SELECT-shaped SQL always
      // has columns, so a keyword sniff suffices for the fake.
      const reader = /^\s*(select|pragma|with|values|explain)\b/i.test(sql);
      return {
        reader,
        all(...args: SqlValue[]): unknown[] {
          if (!reader) {
            throw new TypeError("This statement does not return data");
          }
          return stmt.all(...bindArgs(sql, args));
        },
        run(...args: SqlValue[]): { changes: number | bigint } {
          return stmt.run(...bindArgs(sql, args));
        },
      };
    },
  };
}
