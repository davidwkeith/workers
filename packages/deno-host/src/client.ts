/**
 * Injected client seams for the libSQL/Turso-backed SQL shims.
 *
 * The shims never construct a database connection themselves — the composing
 * app injects a client, exactly like the `WebdavBackend`/`MastodonBackend`
 * seams elsewhere in the repo. Two seams exist because libSQL has two client
 * shapes:
 *
 * - {@link LibsqlClientLike} — the **async remote client** (`@libsql/client`,
 *   or `@libsql/client/web` on Deno Deploy): `execute`/`batch`/
 *   `executeMultiple` over HTTP/hrana. Backs `D1Database` (host-contract
 *   §3.5), whose surface is async already.
 * - {@link SyncSqliteDatabaseLike} — the **synchronous embedded-replica
 *   client** (the `libsql` npm package's better-sqlite3-compatible API, or
 *   any synchronous SQLite handle such as `node:sqlite`'s `DatabaseSync`).
 *   Backs `SqlStorage`/`transactionSync` (host-contract §3.2), whose surface
 *   is synchronous and cannot be satisfied by an async client at all — see
 *   `spec/packages/deno-host.md` §"The synchronous gap".
 *
 * Both are structural subsets of the real clients' types, so a real
 * `@libsql/client` `Client` or `libsql` `Database` instance is assignable
 * as-is; no dependency on either package is taken here.
 */

/** Value types the shims pass through to a client as a positional binding. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/**
 * Strips SQL string/quoted-identifier literals and comments, so structural
 * scans of a query (statement counting, placeholder detection) can't
 * false-positive on `;` or `?N`-shaped content inside a literal.
 */
export const SQL_STRIP_RE =
  /'(?:[^']|'')*'|"(?:[^"]|"")*"|--.*|\/\*[\s\S]*?\*\//g;

/**
 * Coerce a caller-supplied bind value to a {@link SqlValue}, matching the
 * conversions Cloudflare's D1/DO-SQLite apply (booleans become 0/1,
 * `undefined` becomes NULL, `ArrayBuffer` becomes a byte blob).
 */
export function normalizeBinding(value: unknown): SqlValue {
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
  throw new TypeError(`unsupported SQL bind value of type ${typeof value}`);
}

/** One positional-args statement, as `@libsql/client`'s `InStatement`. */
export interface LibsqlStatementLike {
  sql: string;
  args: SqlValue[];
}

/**
 * The result-set subset the shims read, structurally matching
 * `@libsql/client`'s `ResultSet`. `rows` are objects whose columns are
 * readable by name; the shims copy them into plain objects via `columns`, so
 * the client's array-like `Row` hybrids never leak to package code.
 */
export interface LibsqlResultSetLike {
  columns: string[];
  rows: ReadonlyArray<Record<string, unknown>>;
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
}

/** Transaction modes accepted by `@libsql/client`'s `batch`. */
export type LibsqlTransactionMode = "write" | "read" | "deferred";

/**
 * The async remote-client subset backing {@link createD1Database}. `batch`
 * MUST execute its statements in one implicit transaction, in order,
 * rolling back every statement when any fails — `@libsql/client` guarantees
 * exactly this, and host-contract §3.5's atomic-`batch` rule depends on it.
 */
export interface LibsqlClientLike {
  execute(stmt: LibsqlStatementLike): Promise<LibsqlResultSetLike>;
  batch(
    stmts: LibsqlStatementLike[],
    mode?: LibsqlTransactionMode,
  ): Promise<LibsqlResultSetLike[]>;
  executeMultiple(sql: string): Promise<void>;
}

/**
 * A prepared statement on the synchronous client. `reader` is better-sqlite3
 * / `libsql` metadata: `true` when the statement returns rows. Drivers that
 * expose it get writes routed through `run()` (better-sqlite3-family `all()`
 * throws on non-reader statements); drivers that omit it (`node:sqlite`)
 * get every statement routed through `all()`, which they permit.
 */
export interface SyncSqliteStatementLike {
  readonly reader?: boolean;
  all(...args: SqlValue[]): unknown[];
  run(...args: SqlValue[]): { changes: number | bigint };
}

/**
 * The synchronous-client subset backing {@link createSqlStorage} /
 * {@link createDurableSqlite}: `libsql`'s `Database` (embedded replica
 * syncing to a Turso primary) or any better-sqlite3 / `node:sqlite`-shaped
 * handle. `exec` runs statements without bindings (used for
 * BEGIN/COMMIT/ROLLBACK and DDL); `prepare` compiles one statement.
 */
export interface SyncSqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare(sql: string): SyncSqliteStatementLike;
}
