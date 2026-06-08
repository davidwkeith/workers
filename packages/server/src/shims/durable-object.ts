/**
 * Durable Object emulation over `node:sqlite` + an in-process per-id mutex.
 *
 * Durable Objects give the packages three guarantees (`solid-pod`'s entire
 * consistency/authz/notification model and `webauthn`'s per-RP state rest on
 * them): single-threaded execution per object id, DO-SQLite
 * (`state.storage.sql`), and hibernatable WebSockets. In a single Node process
 * the first two are reproduced faithfully — arguably more simply than the
 * distributed original, because there is exactly one process:
 *
 * - **`SqlStorage`** is a `node:sqlite` database, one file per object id under
 *   the data dir, exposing the `sql.exec(query, ...bindings)` cursor
 *   (`.one()` / `.toArray()` / iterable) that `@dwk/store`'s `createStore` and
 *   the DO classes read.
 * - **`DurableObjectNamespace.get(id).fetch(req)`** routes in-process to a
 *   singleton instance per id, serialised behind a **per-id promise chain** — the
 *   single-writer guarantee. `idFromName` mints a stable id.
 * - **WebSocket hibernation** (`acceptWebSocket` / `getWebSockets`) is held in
 *   memory here; wiring it to a real upgrade through the Express server (Solid
 *   notifications) is a follow-up — the LDP/WAC/patch and webauthn paths do not
 *   touch it.
 *
 * The `cloudflare:workers` bare specifier (the only runtime import the packages
 * make, `{ DurableObject }`) resolves to {@link ./cloudflare-workers} via a
 * `module.register` loader hook (the `bin`) or a vitest `resolve.alias` (tests),
 * so the packages run unchanged from source/dist.
 *
 * @see spec/self-hosting.md §7.4, §8
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Value types `node:sqlite` accepts as a positional `?` binding. */
type SqlValue = null | number | bigint | string | Uint8Array;

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
  throw new TypeError(`unsupported SQL bind value of type ${typeof value}`);
}

/** A `SqlStorageCursor`: the result of `sql.exec`, lazily materialised. */
class ShimSqlCursor<T> implements Iterable<T> {
  #rows: T[];

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
    return this.#rows[0] as T;
  }

  toArray(): T[] {
    return this.#rows;
  }

  get columnNames(): string[] {
    const first = this.#rows[0];
    return first ? Object.keys(first as object) : [];
  }

  [Symbol.iterator](): Iterator<T> {
    return this.#rows[Symbol.iterator]();
  }
}

/** `SqlStorage` over a single `node:sqlite` connection. */
class ShimSqlStorage {
  readonly #db: DatabaseSync;
  readonly #cache = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): ShimSqlCursor<T> {
    let stmt = this.#cache.get(query);
    if (stmt === undefined) {
      stmt = this.#db.prepare(query);
      this.#cache.set(query, stmt);
    }
    const rows = stmt.all(...bindings.map(normalize)) as T[];
    return new ShimSqlCursor<T>(rows);
  }

  get databaseSize(): number {
    return 0;
  }
}

/** The DO storage facade — only the surface the packages use. */
class ShimDurableObjectStorage {
  readonly sql: ShimSqlStorage;
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.sql = new ShimSqlStorage(db);
  }

  /** Synchronous transaction; rolls back if `fn` throws. No nesting needed. */
  transactionSync<T>(fn: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.#db.exec("BEGIN");
    try {
      const result = await fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** A `DurableObjectId`: a stable hex id plus the originating name, if any. */
class ShimDurableObjectId {
  readonly #hex: string;
  readonly name?: string;

  constructor(hex: string, name?: string) {
    this.#hex = hex;
    this.name = name;
  }

  toString(): string {
    return this.#hex;
  }

  equals(other: { toString(): string }): boolean {
    return other != null && other.toString() === this.#hex;
  }
}

/** The `DurableObjectState` (`ctx`) a DO instance is constructed with. */
class ShimDurableObjectState {
  readonly id: ShimDurableObjectId;
  readonly storage: ShimDurableObjectStorage;
  readonly #sockets = new Set<WebSocket>();

  constructor(id: ShimDurableObjectId, sqlitePath: string) {
    this.id = id;
    if (sqlitePath !== ":memory:") {
      mkdirSync(dirname(sqlitePath), { recursive: true });
    }
    this.storage = new ShimDurableObjectStorage(new DatabaseSync(sqlitePath));
  }

  /** Run `fn` to completion; on Node there is no concurrent entry to block. */
  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  acceptWebSocket(ws: WebSocket): void {
    this.#sockets.add(ws);
  }

  getWebSockets(): WebSocket[] {
    return [...this.#sockets];
  }
}

/**
 * The `DurableObject` base class the packages extend (`import { DurableObject }
 * from "cloudflare:workers"`). Mirrors the real base: stores `ctx`/`env`.
 */
export class DurableObject<Env = unknown> {
  protected ctx: ShimDurableObjectState;
  protected env: Env;

  constructor(ctx: ShimDurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/**
 * A DO class as the namespace constructs it: `new Ctor(state, env)`. The
 * parameters are `never` so a class whose constructor is typed against the
 * workerd `DurableObjectState` / its concrete `Env` (e.g. `WebAuthnObject`,
 * `SolidPodObject`) is assignable by contravariance; the shim supplies its own
 * `ShimDurableObjectState` and the assembled `Env` at construction.
 */
export type DurableObjectClass<T> = new (state: never, env: never) => T;

/** Minimal `fetch`-bearing stub returned by `namespace.get(id)`. */
interface ShimStub {
  fetch(request: Request): Promise<Response>;
}

interface Instance {
  readonly object: { fetch(request: Request): Promise<Response> };
  /** Per-id serialisation: each fetch chains after the previous settles. */
  chain: Promise<unknown>;
}

/**
 * Options for {@link createDurableObjectNamespace}. `env` is read by reference
 * when an instance is first constructed, so a namespace placed *into* `env`
 * (e.g. `env.POD`) is visible to the instances by the time any request arrives.
 */
export interface DurableObjectNamespaceOptions {
  /** Root data directory; each object id gets `do/<className>/<idHex>.sqlite`. */
  readonly dataDir: string;
  /** The assembled host `Env` passed to each DO instance. */
  readonly env: Readonly<Record<string, unknown>>;
  /** Subdirectory/segment for this namespace's SQLite files. */
  readonly className: string;
}

/**
 * A `DurableObjectNamespace` that routes `get(id).fetch(req)` in-process to a
 * singleton instance per id, serialised behind a per-id promise chain.
 */
class ShimDurableObjectNamespace<
  T extends { fetch(r: Request): Promise<Response> },
> {
  readonly #ctor: DurableObjectClass<T>;
  readonly #options: DurableObjectNamespaceOptions;
  readonly #instances = new Map<string, Instance>();

  constructor(
    ctor: DurableObjectClass<T>,
    options: DurableObjectNamespaceOptions,
  ) {
    this.#ctor = ctor;
    this.#options = options;
  }

  idFromName(name: string): ShimDurableObjectId {
    const hex = createHash("sha256").update(name).digest("hex");
    return new ShimDurableObjectId(hex, name);
  }

  idFromString(hex: string): ShimDurableObjectId {
    return new ShimDurableObjectId(hex);
  }

  newUniqueId(): ShimDurableObjectId {
    return new ShimDurableObjectId(randomBytes(32).toString("hex"));
  }

  get(id: ShimDurableObjectId): ShimStub {
    return {
      fetch: (request: Request) => this.#dispatch(id, request),
    };
  }

  #dispatch(id: ShimDurableObjectId, request: Request): Promise<Response> {
    const key = id.toString();
    let instance = this.#instances.get(key);
    if (instance === undefined) {
      const sqlitePath = join(
        this.#options.dataDir,
        "do",
        this.#options.className,
        `${key}.sqlite`,
      );
      const state = new ShimDurableObjectState(id, sqlitePath);
      const object = new this.#ctor(state as never, this.#options.env as never);
      instance = { object, chain: Promise.resolve() };
      this.#instances.set(key, instance);
    }
    // Serialise: this fetch runs only after the previous one for this id has
    // settled — reproducing the single-thread-per-object guarantee.
    const result = instance.chain.then(() => instance.object.fetch(request));
    instance.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Build a {@link ShimDurableObjectNamespace} binding for a DO class. Place the
 * returned value into the host `Env` (e.g. `env.POD`); instances are created
 * lazily on first request, one SQLite file per object id under
 * `<dataDir>/do/<className>/`.
 */
export function createDurableObjectNamespace<
  T extends { fetch(r: Request): Promise<Response> },
>(
  ctor: DurableObjectClass<T>,
  options: DurableObjectNamespaceOptions,
): ShimDurableObjectNamespace<T> {
  return new ShimDurableObjectNamespace<T>(ctor, options);
}

export type {
  ShimDurableObjectState as DurableObjectState,
  ShimSqlStorage as SqlStorage,
};
