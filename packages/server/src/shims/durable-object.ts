/**
 * Durable Object emulation over `node:sqlite` + an in-process per-id mutex.
 *
 * Durable Objects give the packages four guarantees (`solid-pod`'s entire
 * consistency/authz/notification model and `webauthn`'s per-RP state rest on
 * them): single-threaded execution per object id, DO-SQLite
 * (`state.storage.sql`), hibernatable WebSockets, and alarms. In a single Node
 * process all four are reproduced faithfully — arguably more simply than the
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
 * - **Alarms** (`storage.setAlarm`/`getAlarm`/`deleteAlarm`, the class's
 *   optional `alarm()` override) persist the scheduled time in the object's own
 *   SQLite file (so they survive a process restart) and fire through a real,
 *   `unref`'d timer that is chained onto the same per-id promise as `fetch` —
 *   an alarm never runs concurrently with a request, or another alarm, on the
 *   same object. A namespace scans its data directory for previously-seen
 *   object ids on construction so a pending alarm fires even if the process
 *   restarts before any request re-touches that id (`activitypub`'s delivery
 *   retry and `atproto-pds`'s did:plc genesis-submission retry both depend on
 *   this — see #379).
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
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Bounded backoff for an `alarm()` override that throws, approximating the
 * platform's own retry-on-exception behaviour. Neither `activitypub` nor
 * `atproto-pds` currently relies on this (both catch internally and re-arm via
 * `setAlarm`), but it keeps the shim faithful for future alarm consumers. */
const ALARM_RETRY_BASE_MS = 2_000;
const ALARM_RETRY_MAX_MS = 30 * 60_000;
const ALARM_RETRY_MAX_ATTEMPTS = 6;

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
  #onAlarmChange?: (scheduledTime: number | null) => void;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.sql = new ShimSqlStorage(db);
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS _shim_alarm (id INTEGER PRIMARY KEY CHECK (id = 0), scheduled_at INTEGER NOT NULL)",
    );
  }

  /**
   * Wired by the namespace right after construction so a `setAlarm`/
   * `deleteAlarm` call (re)arms — or clears — the real timer that fires this
   * instance's `alarm()` override.
   */
  _onAlarmChange(callback: (scheduledTime: number | null) => void): void {
    this.#onAlarmChange = callback;
  }

  /** Persist the scheduled alarm time; overwrites any previously-set alarm. */
  async setAlarm(scheduledTime: number | Date): Promise<void> {
    const time =
      scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    this.#db
      .prepare(
        "INSERT INTO _shim_alarm (id, scheduled_at) VALUES (0, ?) " +
          "ON CONFLICT(id) DO UPDATE SET scheduled_at = excluded.scheduled_at",
      )
      .run(time);
    this.#onAlarmChange?.(time);
  }

  /** The currently-armed epoch-ms alarm time, or `null` if none is set. */
  async getAlarm(): Promise<number | null> {
    const row = this.#db
      .prepare("SELECT scheduled_at FROM _shim_alarm WHERE id = 0")
      .get() as { scheduled_at: number } | undefined;
    return row?.scheduled_at ?? null;
  }

  /** Clear the alarm, if any. A no-op if none is set. */
  async deleteAlarm(): Promise<void> {
    this.#db.prepare("DELETE FROM _shim_alarm WHERE id = 0").run();
    this.#onAlarmChange?.(null);
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

  constructor(id: ShimDurableObjectId, sqlitePath: string) {
    this.id = id;
    if (sqlitePath !== ":memory:") {
      mkdirSync(dirname(sqlitePath), { recursive: true });
    }
    this.storage = new ShimDurableObjectStorage(new DatabaseSync(sqlitePath));
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

/** The `alarm()` override a DO class may implement (optional). */
interface AlarmHandler {
  alarm?(): Promise<void>;
}

interface Instance {
  readonly object: {
    fetch(request: Request): Promise<Response>;
  } & AlarmHandler;
  readonly state: ShimDurableObjectState;
  /** Per-id serialisation: each fetch (and alarm firing) chains after the
   * previous settles. */
  chain: Promise<unknown>;
  /** The live timer for this instance's next alarm, if one is armed. */
  alarmTimer?: NodeJS.Timeout;
  /** Consecutive `alarm()` failures, for the bounded retry backoff. */
  alarmAttempts: number;
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
    this.#restorePendingAlarms();
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
   * Get or lazily construct the singleton instance for `id`. Wires the
   * instance's alarm hook and, on first construction, checks for an alarm
   * persisted by a previous run so it still fires.
   */
  #ensureInstance(id: ShimDurableObjectId): Instance {
    const key = id.toString();
    const existing = this.#instances.get(key);
    if (existing !== undefined) return existing;

    const sqlitePath = join(
      this.#options.dataDir,
      "do",
      this.#options.className,
      `${key}.sqlite`,
    );
    const state = new ShimDurableObjectState(id, sqlitePath);
    const object = new this.#ctor(state as never, this.#options.env as never);
    // Let accepted WebSockets reach the instance's hibernation overrides.
    state._setOwner(object as HibernationHandlers);

    const instance: Instance = {
      object: object as Instance["object"],
      state,
      chain: Promise.resolve(),
      alarmAttempts: 0,
    };
    this.#instances.set(key, instance);
    state.storage._onAlarmChange((scheduledTime) => {
      if (scheduledTime === null) {
        if (instance.alarmTimer) clearTimeout(instance.alarmTimer);
        instance.alarmTimer = undefined;
        return;
      }
      this.#armAlarm(instance, scheduledTime);
    });
    // A restart may leave a pending alarm from a previous run; arm it.
    void state.storage.getAlarm().then((scheduledTime) => {
      if (scheduledTime !== null) this.#armAlarm(instance, scheduledTime);
    });
    return instance;
  }

  /** Discover object ids left over from a previous run so their persisted
   * alarms still fire, even if no request re-touches that id first. */
  #restorePendingAlarms(): void {
    const dir = join(this.#options.dataDir, "do", this.#options.className);
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".sqlite")) continue;
      this.#ensureInstance(new ShimDurableObjectId(file.slice(0, -7)));
    }
  }

  /** (Re-)arm the real timer that fires `instance`'s alarm at `scheduledTime`,
   * clearing any previously-armed timer. A time already in the past fires
   * promptly (zero delay), matching an at-least-once restart recovery. */
  #armAlarm(instance: Instance, scheduledTime: number): void {
    if (instance.alarmTimer) clearTimeout(instance.alarmTimer);
    const delay = Math.max(0, scheduledTime - Date.now());
    const timer = setTimeout(() => void this.#fireAlarm(instance), delay);
    timer.unref?.();
    instance.alarmTimer = timer;
  }

  /** Fire `instance`'s alarm, serialised through its per-id chain so it never
   * runs concurrently with a `fetch` (or another alarm) on the same object. */
  #fireAlarm(instance: Instance): Promise<unknown> {
    instance.alarmTimer = undefined;
    if (typeof instance.object.alarm !== "function") return Promise.resolve();
    const result = instance.chain
      .then(() => instance.state.concurrencyGate)
      .then(() => this.#runAlarm(instance));
    instance.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Invoke the alarm override; on failure, retry with bounded exponential
   * backoff (neither current alarm consumer relies on this — both catch
   * internally and re-arm — but it keeps the shim faithful to the platform). */
  async #runAlarm(instance: Instance): Promise<void> {
    // Consumed like the platform's: if the handler doesn't call `setAlarm`
    // again while it runs, nothing fires again.
    await instance.state.storage.deleteAlarm();
    try {
      await instance.object.alarm?.();
      instance.alarmAttempts = 0;
    } catch (err) {
      instance.alarmAttempts += 1;
      if (instance.alarmAttempts > ALARM_RETRY_MAX_ATTEMPTS) {
        console.error(
          `@dwk/server: alarm() failed after ${instance.alarmAttempts} attempts, giving up:`,
          err,
        );
        return;
      }
      const backoff = Math.min(
        ALARM_RETRY_BASE_MS * 2 ** (instance.alarmAttempts - 1),
        ALARM_RETRY_MAX_MS,
      );
      this.#armAlarm(instance, Date.now() + backoff);
    }
  }

  #dispatch(id: ShimDurableObjectId, request: Request): Promise<Response> {
    const instance = this.#ensureInstance(id);
    // Serialise: this fetch runs only after the previous one for this id has
    // settled (single-thread-per-object), and after any in-flight
    // `blockConcurrencyWhile` work (e.g. async constructor init) completes.
    const result = instance.chain
      .then(() => instance.state.concurrencyGate)
      .then(() => instance.object.fetch(request));
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
