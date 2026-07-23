/**
 * `D1Database` → remote libSQL/Turso shim (host-contract §3.5).
 *
 * D1's client surface is fully async, so it maps 1:1 onto the async libSQL
 * client: `prepare(sql).bind(...)` with `.all()` / `.first()` / `.run()`
 * become `client.execute`, `batch()` becomes `client.batch` (libSQL runs a
 * batch inside one implicit transaction, satisfying D1's atomic, in-order
 * guarantee), and `exec()` becomes `client.executeMultiple`. `meta.changes`
 * is reported from the client's `rowsAffected` — the packages branch on it
 * for `INSERT OR IGNORE` dedup and conditional updates.
 *
 * The dialect is real SQLite (libSQL is a SQLite fork), so the packages'
 * `PRAGMA table_info(...)` migrations and `ON CONFLICT` clauses run
 * unchanged — no translation layer. Read-your-writes holds at the libSQL
 * primary for its own writer; `spec/packages/deno-host.md` lists the
 * explicit live verification this claim still needs.
 *
 * @see spec/packages/deno-host.md
 */

import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1ExecResult,
  D1Meta,
} from "@cloudflare/workers-types";
import {
  normalizeBinding,
  type LibsqlClientLike,
  type LibsqlResultSetLike,
  type LibsqlStatementLike,
  type SqlValue,
} from "./client.js";

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

/**
 * Copy a client row into a plain object keyed by column name, in column
 * order — `@libsql/client` rows are array-like hybrids that also carry
 * numeric keys, which must not leak into package-visible result objects.
 */
function toPlainRow(
  columns: string[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) out[column] = row[column];
  return out;
}

function toResult<T>(rs: LibsqlResultSetLike, duration: number): D1Result<T> {
  const results = rs.rows.map((row) => toPlainRow(rs.columns, row)) as T[];
  const meta = makeMeta(
    rs.rowsAffected,
    rs.lastInsertRowid === undefined ? 0 : Number(rs.lastInsertRowid),
    duration,
  );
  return { results, success: true, meta };
}

class LibsqlD1Statement {
  readonly #client: LibsqlClientLike;
  readonly #sql: string;
  readonly #params: SqlValue[];

  constructor(client: LibsqlClientLike, sql: string, params: SqlValue[] = []) {
    this.#client = client;
    this.#sql = sql;
    this.#params = params;
  }

  /** The positional-args statement this wraps (consumed by `batch`). */
  toStatement(): LibsqlStatementLike {
    return { sql: this.#sql, args: this.#params };
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new LibsqlD1Statement(
      this.#client,
      this.#sql,
      values.map(normalizeBinding),
    ) as unknown as D1PreparedStatement;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const rs = await this.#client.execute(this.toStatement());
    const row = rs.rows[0];
    if (row === undefined) return null;
    const plain = toPlainRow(rs.columns, row);
    if (colName !== undefined) return (plain[colName] ?? null) as T | null;
    return plain as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.#execute<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.#execute<T>();
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const rs = await this.#client.execute(this.toStatement());
    const values = rs.rows.map(
      (row) => rs.columns.map((column) => row[column]) as T,
    );
    if (options?.columnNames) {
      return [rs.columns as unknown as T, ...values];
    }
    return values;
  }

  async #execute<T>(): Promise<D1Result<T>> {
    const start = performance.now();
    const rs = await this.#client.execute(this.toStatement());
    return toResult<T>(rs, performance.now() - start);
  }
}

class LibsqlD1Database implements Pick<
  D1Database,
  "prepare" | "batch" | "exec"
> {
  readonly #client: LibsqlClientLike;

  constructor(client: LibsqlClientLike) {
    this.#client = client;
  }

  prepare(query: string): D1PreparedStatement {
    return new LibsqlD1Statement(
      this.#client,
      query,
    ) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    const stmts = statements.map((statement) => {
      if (!(statement instanceof LibsqlD1Statement)) {
        throw new TypeError(
          "batch: statements must come from this database's prepare()",
        );
      }
      return statement.toStatement();
    });
    const start = performance.now();
    // "write" (BEGIN IMMEDIATE) rather than the client's "deferred" default:
    // D1 batches are used for multi-statement writes, and taking the write
    // lock up front avoids mid-batch SQLITE_BUSY upgrades on a live primary.
    const resultSets = await this.#client.batch(stmts, "write");
    const duration = performance.now() - start;
    return resultSets.map((rs) => toResult<T>(rs, duration));
  }

  async exec(query: string): Promise<D1ExecResult> {
    const start = performance.now();
    await this.#client.executeMultiple(query);
    const count = query.split(";").filter((s) => s.trim().length > 0).length;
    return { count, duration: performance.now() - start };
  }
}

/**
 * Create a {@link D1Database} backed by an injected async libSQL client
 * (`@libsql/client`, or anything satisfying {@link LibsqlClientLike}). One
 * client — one logical libSQL/Turso database — backs one D1 binding.
 */
export function createD1Database(client: LibsqlClientLike): D1Database {
  // The shim implements the subset the packages use; the broad D1Database type
  // (with `dump`/`withSession`) is satisfied structurally via an explicit cast.
  return new LibsqlD1Database(client) as unknown as D1Database;
}
