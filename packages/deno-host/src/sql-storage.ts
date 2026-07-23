/**
 * `SqlStorage` + `transactionSync` → synchronous libSQL shim (host-contract
 * §3.2).
 *
 * The DO-SQLite surface is synchronous — `sql.exec(...)` returns a cursor
 * whose rows are readable immediately, and `transactionSync(fn)` commits or
 * rolls back around a synchronous `fn`. An async remote client cannot back
 * that surface (there is no way to return rows synchronously from a promise),
 * so this shim takes libSQL's **synchronous embedded-replica client** (the
 * `libsql` npm package's better-sqlite3-compatible API): reads execute
 * against the instance-local replica file, writes block the calling thread
 * while they are forwarded to the Turso primary — which is exactly the
 * semantics the contract's "synchronous" wording encodes ("the whole DO
 * event loop blocks until commit"). Any better-sqlite3 / `node:sqlite`-shaped
 * handle also satisfies the seam, which is how the colocated tests drive it.
 *
 * Cursor semantics follow Cloudflare's real cursor: one-shot iteration
 * (`next()` / `for…of` consume rows; `toArray()` drains what remains), and
 * `one()` requires the result to be exactly one row.
 *
 * @see spec/packages/deno-host.md
 */

import {
  normalizeBinding,
  type SyncSqliteDatabaseLike,
  type SyncSqliteStatementLike,
} from "./client.js";

/** A `SqlStorageCursor`: the one-shot result of `sql.exec`. */
export class SyncSqlCursor<T> implements IterableIterator<T> {
  readonly #rows: T[];
  #index = 0;

  constructor(rows: T[]) {
    this.#rows = rows;
  }

  /** Exactly one row; throws if the query returned zero or more than one. */
  one(): T {
    if (this.#rows.length !== 1) {
      throw new Error(
        `sql.exec().one() expected exactly one row, got ${this.#rows.length}`,
      );
    }
    this.#index = this.#rows.length;
    return this.#rows[0] as T;
  }

  /** The not-yet-iterated rows; exhausts the cursor. */
  toArray(): T[] {
    const rest = this.#rows.slice(this.#index);
    this.#index = this.#rows.length;
    return rest;
  }

  get columnNames(): string[] {
    const first = this.#rows[0];
    return first ? Object.keys(first as object) : [];
  }

  next(): IteratorResult<T> {
    if (this.#index >= this.#rows.length) {
      return { done: true, value: undefined };
    }
    return { done: false, value: this.#rows[this.#index++] as T };
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this;
  }
}

/** `SqlStorage` over a single synchronous libSQL/SQLite connection. */
export class SyncSqlStorage {
  readonly #db: SyncSqliteDatabaseLike;
  readonly #cache = new Map<string, SyncSqliteStatementLike>();

  constructor(db: SyncSqliteDatabaseLike) {
    this.#db = db;
  }

  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SyncSqlCursor<T> {
    let stmt = this.#cache.get(query);
    if (stmt === undefined) {
      stmt = this.#db.prepare(query);
      this.#cache.set(query, stmt);
    }
    const args = bindings.map(normalizeBinding);
    // better-sqlite3-family statements refuse `all()` on non-reader
    // statements; drivers that don't expose `reader` (node:sqlite) accept
    // `all()` for everything.
    if (stmt.reader === false) {
      stmt.run(...args);
      return new SyncSqlCursor<T>([]);
    }
    return new SyncSqlCursor<T>(stmt.all(...args) as T[]);
  }
}

/**
 * The host-contract §3.2 slice of `DurableObjectStorage`: the `sql` member
 * plus `transactionSync`. The DO emulation layer (issue #398) embeds this in
 * the full `DurableObjectState` it hands a constructed object.
 */
export interface DurableSqlite {
  readonly sql: SyncSqlStorage;
  transactionSync<T>(fn: () => T): T;
}

/** Create just the `sql` member (e.g. for `@dwk/webdav`'s injected stores). */
export function createSqlStorage(db: SyncSqliteDatabaseLike): SyncSqlStorage {
  return new SyncSqlStorage(db);
}

/**
 * Create the `{ sql, transactionSync }` pair over one synchronous
 * connection. `transactionSync` commits on return and rolls the whole
 * transaction back when `fn` throws — the multi-statement writes in
 * `@dwk/store`, `solid-pod`, and `atproto-pds` rely on that atomicity. No
 * nesting (matching the packages' usage and `@dwk/cf-shims`).
 */
export function createDurableSqlite(db: SyncSqliteDatabaseLike): DurableSqlite {
  let inTransaction = false;
  return {
    sql: new SyncSqlStorage(db),
    transactionSync<T>(fn: () => T): T {
      // Guard against nesting explicitly: without it the inner BEGIN throws,
      // the inner ROLLBACK discards the outer transaction's writes, and the
      // outer rollback then throws again, obscuring the original error.
      if (inTransaction) {
        throw new Error("transactionSync does not support nesting");
      }
      inTransaction = true;
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        inTransaction = false;
      }
    },
  };
}
