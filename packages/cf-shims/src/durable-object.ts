/**
 * Durable Object emulation over `node:sqlite` + an in-process per-id mutex.
 *
 * Durable Objects give the packages four guarantees (`solid-pod`'s entire
 * consistency/authz/notification model and `webauthn`'s per-RP state rest on
 * them): single-threaded execution per object id, DO-SQLite
 * (`state.storage.sql`), alarms, and hibernatable WebSockets. In a single Node
 * process these are reproduced faithfully — arguably more simply than the
 * distributed original, because there is exactly one process:
 *
 * - **`SqlStorage`** is a `node:sqlite` database, one file per object id under
 *   the data dir, exposing the `sql.exec(query, ...bindings)` cursor
 *   (`.one()` / `.toArray()` / iterable) that `@dwk/store`'s `createStore` and
 *   the DO classes read.
 * - **`DurableObjectNamespace.get(id).fetch(req)`** routes in-process to a
 *   singleton instance per id, serialised behind a **per-id promise chain** — the
 *   single-writer guarantee. `idFromName` mints a stable id.
 * - **Alarms** (`storage.setAlarm`/`getAlarm`/`deleteAlarm` + the class's
 *   `alarm()` override) persist the scheduled time in the same per-object
 *   SQLite file, so they survive restarts: the namespace re-arms persisted
 *   alarms on construction (a past-due alarm fires immediately). The handler
 *   runs through the same per-id chain as `fetch`, the alarm is deleted before
 *   the handler runs (Cloudflare's contract — re-arming is the handler's job),
 *   and a throwing handler is retried with bounded exponential backoff.
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
import { mkdirSync, readdirSync } from "node:fs";
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

/** The retry metadata Cloudflare passes to `alarm()`; the shim matches it. */
export interface AlarmInvocationInfo {
  readonly retryCount: number;
  readonly isRetry: boolean;
}

/**
 * Shim-owned table holding the object's (single) pending alarm. Underscore-
 * prefixed so it cannot collide with a package's own schema, and stored in the
 * object's SQLite file so alarms survive a host restart.
 */
const ALARM_TABLE_DDL =
  "CREATE TABLE IF NOT EXISTS _host_alarm " +
  "(id INTEGER PRIMARY KEY CHECK (id = 1), scheduled_time INTEGER NOT NULL)";

/**
 * Read the persisted alarm time from an object's SQLite file without
 * constructing the object (namespace startup recovery). Returns null when the
 * file is unreadable or the object never set an alarm.
 */
function readPersistedAlarm(sqlitePath: string): number | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(sqlitePath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare("SELECT scheduled_time AS t FROM _host_alarm WHERE id = 1")
      .get() as { t: number | bigint } | undefined;
    return row === undefined ? null : Number(row.t);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** The DO storage facade — only the surface the packages use. */
class ShimDurableObjectStorage {
  readonly sql: ShimSqlStorage;
  readonly #db: DatabaseSync;
  readonly #onAlarmChange?: (scheduledTime: number | null) => void;
  #alarmTableReady = false;
  #inTransaction = false;

  constructor(
    db: DatabaseSync,
    onAlarmChange?: (scheduledTime: number | null) => void,
  ) {
    this.#db = db;
    this.sql = new ShimSqlStorage(db);
    this.#onAlarmChange = onAlarmChange;
  }

  #ensureAlarmTable(): void {
    if (this.#alarmTableReady) return;
    this.#db.exec(ALARM_TABLE_DDL);
    this.#alarmTableReady = true;
  }

  /** Schedule (or replace) the object's single alarm at an epoch-ms time. */
  async setAlarm(scheduledTime: number | Date): Promise<void> {
    const time =
      typeof scheduledTime === "number"
        ? scheduledTime
        : scheduledTime.getTime();
    if (!Number.isFinite(time)) {
      throw new TypeError("setAlarm: scheduledTime must be a finite time");
    }
    this.#ensureAlarmTable();
    this.#db
      .prepare(
        "INSERT INTO _host_alarm (id, scheduled_time) VALUES (1, ?) " +
          "ON CONFLICT (id) DO UPDATE SET scheduled_time = excluded.scheduled_time",
      )
      .run(time);
    this.#onAlarmChange?.(time);
  }

  async getAlarm(): Promise<number | null> {
    this.#ensureAlarmTable();
    const row = this.#db
      .prepare("SELECT scheduled_time AS t FROM _host_alarm WHERE id = 1")
      .get() as { t: number | bigint } | undefined;
    return row === undefined ? null : Number(row.t);
  }

  async deleteAlarm(): Promise<void> {
    this.#ensureAlarmTable();
    this.#db.prepare("DELETE FROM _host_alarm WHERE id = 1").run();
    this.#onAlarmChange?.(null);
  }

  /**
   * Nesting is unsupported (as on Cloudflare) and must fail loudly: without
   * this guard the inner BEGIN throws, the inner ROLLBACK discards the
   * outer, still-open transaction's writes, and the outer rollback then
   * throws again, obscuring the original error. The flag is shared between
   * `transactionSync` and `transaction` — both run on the same connection —
   * so it also fires for concurrent-but-not-lexically-nested calls, e.g.
   * two `transaction()` promises overlapping while one is mid-`await`;
   * hence the "overlapping" wording in the error.
   */
  #enterTransaction(kind: string): void {
    if (this.#inTransaction) {
      throw new Error(
        `${kind} does not support nesting or overlapping an in-flight transaction`,
      );
    }
    this.#inTransaction = true;
  }

  /** Synchronous transaction; rolls back if `fn` throws. No nesting. */
  transactionSync<T>(fn: () => T): T {
    this.#enterTransaction("transactionSync");
    this.#db.exec("BEGIN");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    } finally {
      this.#inTransaction = false;
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.#enterTransaction("transaction");
    this.#db.exec("BEGIN");
    try {
      const result = await fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    } finally {
      this.#inTransaction = false;
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

/** The hibernation overrides a DO class may implement (all optional). */
interface HibernationHandlers {
  webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): unknown;
  webSocketClose?(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): unknown;
  webSocketError?(ws: WebSocket, error: unknown): unknown;
}

/** The `DurableObjectState` (`ctx`) a DO instance is constructed with. */
class ShimDurableObjectState {
  readonly id: ShimDurableObjectId;
  readonly storage: ShimDurableObjectStorage;
  readonly #sockets = new Set<WebSocket>();
  #concurrencyGate: Promise<unknown> = Promise.resolve();
  #owner?: HibernationHandlers;

  constructor(
    id: ShimDurableObjectId,
    sqlitePath: string,
    onAlarmChange?: (scheduledTime: number | null) => void,
  ) {
    this.id = id;
    if (sqlitePath !== ":memory:") {
      mkdirSync(dirname(sqlitePath), { recursive: true });
    }
    this.storage = new ShimDurableObjectStorage(
      new DatabaseSync(sqlitePath),
      onAlarmChange,
    );
  }

  /**
   * The owning DO instance, set by the namespace once constructed, so accepted
   * WebSockets can be dispatched to its hibernation overrides.
   */
  _setOwner(owner: HibernationHandlers): void {
    this.#owner = owner;
  }

  /**
   * Work the namespace awaits before delivering the next request, so a
   * `blockConcurrencyWhile` call — typically async initialisation in a DO
   * constructor — actually gates incoming requests rather than racing them.
   */
  get concurrencyGate(): Promise<unknown> {
    return this.#concurrencyGate;
  }

  /**
   * Run `fn` while holding off request delivery (see {@link concurrencyGate}).
   * Chains onto the current gate so multiple calls run in order; a rejection is
   * isolated to its caller and does not wedge the gate.
   */
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#concurrencyGate.then(fn);
    this.#concurrencyGate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  acceptWebSocket(ws: WebSocket): void {
    this.#sockets.add(ws);
    // The DO drives delivery through the hibernation API, not events: a frame on
    // an accepted socket invokes its `webSocketMessage` override, an error its
    // `webSocketError`, and close its `webSocketClose`.
    const onMessage = (event: Event): void => {
      const data = (event as unknown as { data: string | ArrayBuffer }).data;
      void this.#owner?.webSocketMessage?.(ws, data);
    };
    const onError = (event: Event): void => {
      const error = ((event ?? {}) as { error?: unknown }).error;
      void this.#owner?.webSocketError?.(ws, error);
    };
    // Drop the socket on close and detach the listeners, so a closed connection
    // does not retain this state (and the DO instance) via the socket.
    const cleanup = (event?: Event): void => {
      if (!this.#sockets.delete(ws)) return;
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", cleanup);
      const { code, reason, wasClean } = (event ?? {}) as {
        code?: number;
        reason?: string;
        wasClean?: boolean;
      };
      void this.#owner?.webSocketClose?.(
        ws,
        code ?? 1000,
        reason ?? "",
        wasClean ?? true,
      );
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", cleanup);
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

  /** Alarm handler a subclass may override; fired by the namespace scheduler. */
  alarm?(alarmInfo?: AlarmInvocationInfo): void | Promise<void>;

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
  readonly state: ShimDurableObjectState;
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
  /**
   * Retry policy for a throwing `alarm()` handler. Defaults mirror Cloudflare:
   * up to 6 retries with exponential backoff starting at 2 s. Overridable so
   * tests can exercise the retry path without real delays.
   */
  readonly alarmRetry?: {
    readonly maxRetries?: number;
    readonly baseDelayMs?: number;
  };
}

/** `setTimeout` overflows past 2^31-1 ms; longer waits re-check on fire. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

interface AlarmEntry {
  /** The pending fire-or-retry timer for this id, if any. */
  timer: ReturnType<typeof setTimeout> | null;
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
  readonly #alarms = new Map<string, AlarmEntry>();
  readonly #alarmMaxRetries: number;
  readonly #alarmBaseDelayMs: number;

  constructor(
    ctor: DurableObjectClass<T>,
    options: DurableObjectNamespaceOptions,
  ) {
    this.#ctor = ctor;
    this.#options = options;
    this.#alarmMaxRetries = options.alarmRetry?.maxRetries ?? 6;
    this.#alarmBaseDelayMs = options.alarmRetry?.baseDelayMs ?? 2000;
    this.#recoverPersistedAlarms();
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

  /**
   * Cancel all pending alarm timers. Calling this is optional and is the
   * composition root's job if it wants a quiescent shutdown — the host itself
   * does not track namespaces, and every timer is `unref`'d, so process exit
   * is never blocked either way (today only tests call this). Persisted alarm
   * times survive in the objects' SQLite files and are re-armed by the next
   * namespace construction over the same data directory.
   */
  dispose(): void {
    for (const entry of this.#alarms.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  /** The singleton instance for an id, constructing it on first use. */
  #materialize(id: ShimDurableObjectId): Instance {
    const key = id.toString();
    let instance = this.#instances.get(key);
    if (instance === undefined) {
      const sqlitePath = join(
        this.#options.dataDir,
        "do",
        this.#options.className,
        `${key}.sqlite`,
      );
      const state = new ShimDurableObjectState(id, sqlitePath, (time) => {
        if (time === null) this.#cancelAlarm(key);
        else this.#scheduleAlarm(key, time);
      });
      const object = new this.#ctor(state as never, this.#options.env as never);
      // Let accepted WebSockets reach the instance's hibernation overrides.
      state._setOwner(object as HibernationHandlers);
      instance = { object, state, chain: Promise.resolve() };
      this.#instances.set(key, instance);
    }
    return instance;
  }

  #dispatch(id: ShimDurableObjectId, request: Request): Promise<Response> {
    const current = this.#materialize(id);
    // Serialise: this fetch runs only after the previous one for this id has
    // settled (single-thread-per-object), and after any in-flight
    // `blockConcurrencyWhile` work (e.g. async constructor init) completes.
    const result = current.chain
      .then(() => current.state.concurrencyGate)
      .then(() => current.object.fetch(request));
    current.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #alarmEntry(key: string): AlarmEntry {
    let entry = this.#alarms.get(key);
    if (entry === undefined) {
      entry = { timer: null };
      this.#alarms.set(key, entry);
    }
    return entry;
  }

  #cancelAlarm(key: string): void {
    const entry = this.#alarms.get(key);
    if (entry?.timer != null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  /** Arm (or re-arm, replacing any pending timer) the alarm for an id. */
  #scheduleAlarm(key: string, scheduledTime: number): void {
    const entry = this.#alarmEntry(key);
    if (entry.timer !== null) clearTimeout(entry.timer);
    const delay = Math.min(
      Math.max(scheduledTime - Date.now(), 0),
      MAX_TIMER_DELAY_MS,
    );
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.#fireAlarm(key, 0);
    }, delay);
    // Pending alarms must not keep an otherwise-finished process alive; the
    // host's own server keeps the loop running in production.
    entry.timer.unref?.();
  }

  /**
   * Deliver `alarm()` for an id, serialised on the same per-id chain as
   * `fetch`. On the first attempt the persisted alarm is the source of truth:
   * a deleted alarm no-ops, a rescheduled-later one re-arms (this also covers
   * clamped far-future timers), and a due one is deleted *before* the handler
   * runs, matching Cloudflare — re-arming is the handler's job. A throwing
   * handler is retried with exponential backoff up to the configured cap,
   * unless the failed attempt itself set a new alarm (which supersedes the
   * retry). Exhausted retries are dropped; the handler owns its error
   * reporting (same posture as the cron shim).
   */
  async #fireAlarm(key: string, retryCount: number): Promise<void> {
    const instance = this.#materialize(new ShimDurableObjectId(key));
    const run = instance.chain
      .then(() => instance.state.concurrencyGate)
      .then(async () => {
        if (retryCount === 0) {
          const scheduled = await instance.state.storage.getAlarm();
          if (scheduled === null) return;
          if (scheduled > Date.now()) {
            this.#scheduleAlarm(key, scheduled);
            return;
          }
          await instance.state.storage.deleteAlarm();
        }
        const handler = (
          instance.object as {
            alarm?: (info: AlarmInvocationInfo) => void | Promise<void>;
          }
        ).alarm;
        if (typeof handler !== "function") return;
        await handler.call(instance.object, {
          retryCount,
          isRetry: retryCount > 0,
        });
      });
    instance.chain = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      await run;
    } catch {
      if (retryCount >= this.#alarmMaxRetries) return;
      if ((await instance.state.storage.getAlarm()) !== null) return;
      const entry = this.#alarmEntry(key);
      if (entry.timer !== null) return;
      entry.timer = setTimeout(
        () => {
          entry.timer = null;
          void this.#fireAlarm(key, retryCount + 1);
        },
        this.#alarmBaseDelayMs * 2 ** retryCount,
      );
      entry.timer.unref?.();
    }
  }

  /**
   * Re-arm alarms persisted by a previous process (restart recovery). Object
   * ids are recovered from the SQLite filenames; a past-due alarm fires
   * immediately, constructing the instance without waiting for a request.
   */
  #recoverPersistedAlarms(): void {
    const dir = join(this.#options.dataDir, "do", this.#options.className);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }
    for (const file of files) {
      const key = /^([0-9a-f]+)\.sqlite$/.exec(file)?.[1];
      if (key === undefined) continue;
      const time = readPersistedAlarm(join(dir, file));
      if (time !== null) this.#scheduleAlarm(key, time);
    }
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
