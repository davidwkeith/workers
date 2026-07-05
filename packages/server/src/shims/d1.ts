/**
 * `D1Database` → `node:sqlite` shim.
 *
 * D1's surface is small and SQLite-shaped already: `prepare(sql).bind(...)` with
 * `.all()` / `.first()` / `.run()`, plus `batch()` and `exec()`, returning the
 * `{ results, success, meta }` envelope. This wraps a synchronous `node:sqlite`
 * connection to provide exactly that object shape. One local SQLite file is
 * strictly serializable, so session / read-your-writes consistency is automatic
 * — stronger than D1's default and trivially satisfying the consistency rules.
 *
 * `node:sqlite` is built-in and synchronous, matching the synchronous SQLite
 * surface; it is confined to this module so the driver stays swappable.
 *
 * @see spec/self-hosting.md §7.1
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1ExecResult,
  D1Meta,
} from "@cloudflare/workers-types";

/** Value types `node:sqlite` accepts as a positional `?` binding. */
type SqlValue = null | number | bigint | string | Uint8Array;

/** Matches SQLite's numbered placeholder form (`?1`, `?2`, ...). */
const NUMBERED_PLACEHOLDER = /\?\d+/;

/**
 * Build the argument list `node:sqlite`'s `StatementSync` methods expect.
 *
 * `node:sqlite` binds anonymous `?` placeholders from a positional argument
 * list, but numbered `?N` placeholders (D1/SQLite-valid, and what
 * `@dwk/microsub` and `@dwk/websub` use) must be bound via an object keyed by
 * placeholder number — passing them positionally throws "column index out of
 * range". D1's `.bind(...)` contract is positional regardless of style, so
 * `?N` is mapped from the Nth bound value (1-indexed).
 */
function bindArgs(sql: string, params: SqlValue[]): SqlValue[] {
  if (!NUMBERED_PLACEHOLDER.test(sql)) return params;
  const named: Record<number, SqlValue> = {};
  params.forEach((value, index) => {
    named[index + 1] = value;
  });
  return [named] as unknown as SqlValue[];
}

/** Coerce a D1 bind value to what `node:sqlite` accepts. */
function normalize(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new TypeError(`unsupported D1 bind value of type ${typeof value}`);
}

function makeMeta(
  changes: number,
  lastRowId: number,
  duration: number,
): D1Meta & Record<string, unknown> {
  return {
    duration,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  } satisfies D1Meta as D1Meta & Record<string, unknown>;
}

/** Internal connection wrapper holding the cached compiled statements. */
class Connection {
  readonly db: DatabaseSync;
  readonly #cache = new Map<string, StatementSync>();
  readonly #changes: StatementSync;
  readonly #rowId: StatementSync;

  constructor(location: string) {
    if (location !== ":memory:")
      mkdirSync(dirname(location), { recursive: true });
    this.db = new DatabaseSync(location);
    this.#changes = this.db.prepare("SELECT changes() AS c");
    this.#rowId = this.db.prepare("SELECT last_insert_rowid() AS r");
  }

  prepareCached(sql: string): StatementSync {
    let stmt = this.#cache.get(sql);
    if (stmt === undefined) {
      stmt = this.db.prepare(sql);
      this.#cache.set(sql, stmt);
    }
    return stmt;
  }

  /** Most recent write's row count (unaffected by intervening SELECTs). */
  lastChanges(): number {
    return Number((this.#changes.get() as { c: number | bigint }).c);
  }

  lastRowId(): number {
    return Number((this.#rowId.get() as { r: number | bigint }).r);
  }
}

class SqliteD1Statement {
  readonly #conn: Connection;
  readonly #sql: string;
  readonly #params: SqlValue[];

  constructor(conn: Connection, sql: string, params: SqlValue[] = []) {
    this.#conn = conn;
    this.#sql = sql;
    this.#params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1Statement(
      this.#conn,
      this.#sql,
      values.map(normalize),
    ) as unknown as D1PreparedStatement;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const stmt = this.#conn.prepareCached(this.#sql);
    const row = stmt.get(...bindArgs(this.#sql, this.#params)) as
      Record<string, unknown> | undefined;
    if (row === undefined) return null;
    if (colName !== undefined) return (row[colName] ?? null) as T | null;
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.#execute<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.#execute<T>();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.#conn.prepareCached(this.#sql);
    const rows = stmt.all(...bindArgs(this.#sql, this.#params)) as Record<
      string,
      unknown
    >[];
    const values = rows.map((row) => Object.values(row) as T);
    if (options?.columnNames && rows[0]) {
      return [Object.keys(rows[0]) as unknown as T, ...values];
    }
    return values;
  }

  /** Shared execution: runs the statement, returns rows + accurate meta. */
  #execute<T>(): D1Result<T> {
    const stmt = this.#conn.prepareCached(this.#sql);
    const start = performance.now();
    const rows = stmt.all(...bindArgs(this.#sql, this.#params)) as T[];
    const meta = makeMeta(
      this.#conn.lastChanges(),
      this.#conn.lastRowId(),
      performance.now() - start,
    );
    return { results: rows, success: true, meta };
  }
}

class SqliteD1Database implements Pick<
  D1Database,
  "prepare" | "batch" | "exec"
> {
  readonly #conn: Connection;

  constructor(conn: Connection) {
    this.#conn = conn;
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(
      this.#conn,
      query,
    ) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    // D1 batches are atomic: wrap in a single transaction.
    this.#conn.db.exec("BEGIN");
    try {
      const out = await Promise.all(statements.map((s) => s.all<T>()));
      this.#conn.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.#conn.db.exec("ROLLBACK");
      throw err;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    const start = performance.now();
    this.#conn.db.exec(query);
    const count = query.split(";").filter((s) => s.trim().length > 0).length;
    return { count, duration: performance.now() - start };
  }
}

/**
 * Create a {@link D1Database} backed by a `node:sqlite` file (or `:memory:`).
 * One file backs one logical D1 binding; the parent directory is created if
 * needed.
 */
export function createD1Database(location: string): D1Database {
  // The shim implements the subset the packages use; the broad D1Database type
  // (with `dump`/`withSession`) is satisfied structurally via an explicit cast.
  return new SqliteD1Database(
    new Connection(location),
  ) as unknown as D1Database;
}
