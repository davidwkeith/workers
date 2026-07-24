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
import type {
  DenoKvAtomicLike,
  DenoKvCheckLike,
  DenoKvCommitResultLike,
  DenoKvEntryLike,
  DenoKvLike,
  DenoKvListSelectorLike,
  KvKey,
  KvKeyPart,
} from "./kv-client.js";

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

interface FakeKvRecord {
  readonly key: KvKey;
  value: unknown;
  versionstamp: string;
  expiresAt: number | null;
}

function keyTypeRank(part: KvKeyPart): number {
  if (part instanceof Uint8Array) return 0;
  if (typeof part === "bigint") return 1;
  if (typeof part === "number") return 2;
  if (typeof part === "string") return 3;
  return 4; // boolean
}

function compareKeyPart(a: KvKeyPart, b: KvKeyPart): number {
  const ra = keyTypeRank(a);
  const rb = keyTypeRank(b);
  if (ra !== rb) return ra - rb;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return a.length - b.length;
  }
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b ? 0 : a ? 1 : -1;
  }
  return 0;
}

function compareKeys(a: KvKey, b: KvKey): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const c = compareKeyPart(a[i] as KvKeyPart, b[i] as KvKeyPart);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function hasPrefix(key: KvKey, prefix: KvKey): boolean {
  if (key.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (compareKeyPart(key[i] as KvKeyPart, prefix[i] as KvKeyPart) !== 0) {
      return false;
    }
  }
  return true;
}

function keyToId(key: KvKey): string {
  return key
    .map((part) =>
      part instanceof Uint8Array
        ? `bytes:${Buffer.from(part).toString("hex")}`
        : `${typeof part}:${String(part)}`,
    )
    .join("\u0000");
}

/**
 * An in-memory `DenoKvLike` reproducing `Deno.Kv`'s documented atomic-CAS
 * semantics: `atomic().check(...)` compares the current versionstamp
 * exactly (including `null` for "must not exist"), `set`/`delete` only
 * apply if every check passes, and `expireIn` entries are pruned lazily on
 * access. Key comparison (used by `list`'s ordering/range) ranks by type
 * first (bytes < bigint < number < string < boolean) then by value —
 * sufficient for this package's own key shapes (string/number only); real
 * `Deno.Kv` ordering is a live-verification item, not something this fake
 * needs to match exactly (see spec/packages/deno-host.md).
 */
export class FakeDenoKv implements DenoKvLike {
  readonly #store = new Map<string, FakeKvRecord>();
  #version = 0;

  #nextVersionstamp(): string {
    this.#version += 1;
    return this.#version.toString().padStart(20, "0");
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, rec] of this.#store) {
      if (rec.expiresAt !== null && rec.expiresAt <= now) {
        this.#store.delete(id);
      }
    }
  }

  async get<T = unknown>(key: KvKey): Promise<DenoKvEntryLike<T>> {
    this.#prune();
    const rec = this.#store.get(keyToId(key));
    return {
      key,
      value: (rec?.value ?? null) as T,
      versionstamp: rec?.versionstamp ?? null,
    };
  }

  async set(
    key: KvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<{ versionstamp: string }> {
    const versionstamp = this.#nextVersionstamp();
    this.#store.set(keyToId(key), {
      key,
      value,
      versionstamp,
      expiresAt:
        options?.expireIn != null ? Date.now() + options.expireIn : null,
    });
    return { versionstamp };
  }

  async delete(key: KvKey): Promise<void> {
    this.#store.delete(keyToId(key));
  }

  async *list<T = unknown>(
    selector: DenoKvListSelectorLike,
    options?: { limit?: number },
  ): AsyncIterableIterator<DenoKvEntryLike<T>> {
    this.#prune();
    const matches: FakeKvRecord[] = [];
    for (const rec of this.#store.values()) {
      if (!hasPrefix(rec.key, selector.prefix)) continue;
      if (
        selector.start !== undefined &&
        compareKeys(rec.key, selector.start) < 0
      ) {
        continue;
      }
      if (
        selector.end !== undefined &&
        compareKeys(rec.key, selector.end) >= 0
      ) {
        continue;
      }
      matches.push(rec);
    }
    matches.sort((a, b) => compareKeys(a.key, b.key));
    const limited =
      options?.limit != null ? matches.slice(0, options.limit) : matches;
    for (const rec of limited) {
      yield {
        key: rec.key,
        value: rec.value as T,
        versionstamp: rec.versionstamp,
      };
    }
  }

  atomic(): DenoKvAtomicLike {
    return new FakeDenoKvAtomic(this);
  }

  /** @internal accessed by {@link FakeDenoKvAtomic} only. */
  _get(id: string): FakeKvRecord | undefined {
    this.#prune();
    return this.#store.get(id);
  }
  /** @internal accessed by {@link FakeDenoKvAtomic} only. */
  _write(id: string, rec: FakeKvRecord): void {
    this.#store.set(id, rec);
  }
  /** @internal accessed by {@link FakeDenoKvAtomic} only. */
  _delete(id: string): void {
    this.#store.delete(id);
  }
  /** @internal accessed by {@link FakeDenoKvAtomic} only. */
  _nextVersionstamp(): string {
    return this.#nextVersionstamp();
  }
}

type FakeKvOp =
  | {
      readonly type: "set";
      readonly key: KvKey;
      readonly value: unknown;
      readonly expireIn?: number;
    }
  | { readonly type: "delete"; readonly key: KvKey };

class FakeDenoKvAtomic implements DenoKvAtomicLike {
  readonly #kv: FakeDenoKv;
  readonly #checks: DenoKvCheckLike[] = [];
  readonly #ops: FakeKvOp[] = [];

  constructor(kv: FakeDenoKv) {
    this.#kv = kv;
  }

  check(...checks: DenoKvCheckLike[]): DenoKvAtomicLike {
    this.#checks.push(...checks);
    return this;
  }

  set(
    key: KvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): DenoKvAtomicLike {
    this.#ops.push({ type: "set", key, value, expireIn: options?.expireIn });
    return this;
  }

  delete(key: KvKey): DenoKvAtomicLike {
    this.#ops.push({ type: "delete", key });
    return this;
  }

  async commit(): Promise<DenoKvCommitResultLike> {
    for (const c of this.#checks) {
      const rec = this.#kv._get(keyToId(c.key));
      const actual = rec?.versionstamp ?? null;
      if (actual !== c.versionstamp) return { ok: false };
    }
    let versionstamp: string | undefined;
    for (const op of this.#ops) {
      const id = keyToId(op.key);
      if (op.type === "delete") {
        this.#kv._delete(id);
      } else {
        versionstamp = this.#kv._nextVersionstamp();
        this.#kv._write(id, {
          key: op.key,
          value: op.value,
          versionstamp,
          expiresAt: op.expireIn != null ? Date.now() + op.expireIn : null,
        });
      }
    }
    return { ok: true, versionstamp };
  }
}
