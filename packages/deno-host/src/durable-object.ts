/**
 * The single-writer actor: `createDurableObjectNamespace`, tying the KV
 * lease (lease.ts) and #397's `createDurableSqlite` into one per-id Durable
 * Object emulation — host-contract §3.3. Alarm emulation (rule 2) is added
 * on top of this in a follow-up change to this same file (issue #398).
 *
 * @see spec/packages/deno-host.md "Design: single-writer actor + alarm
 * emulation (issue #398)"
 */

import type { DenoKvLike, KvKey } from "./kv-client.js";
import {
  acquireLease,
  releaseLease,
  type Lease,
  type LeaseOptions,
} from "./lease.js";
import { createDurableSqlite, type DurableSqlite } from "./sql-storage.js";
import type { SyncSqliteDatabaseLike } from "./client.js";
import {
  setAlarm,
  getAlarm,
  deleteAlarm as deleteAlarmKv,
  scheduleRetry,
  listDueAlarms,
  claimDueAlarm,
  clearClaimedAlarm,
} from "./alarms.js";

/* ---------- id ---------- */

function fnv1a(seed: number, input: string): number {
  let hash = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Small, dependency-free synchronous hash for stable id derivation.
 * `idFromName` must be synchronous (matching real Cloudflare and
 * `@dwk/cf-shims`), and `crypto.subtle.digest` is async-only, so this is
 * not cryptographic — distribution/stability only, same rationale
 * `@dwk/cf-shims` had for using sha256.
 */
function hashToHex(input: string): string {
  let hex = "";
  for (let seed = 0; seed < 4; seed++) {
    hex += fnv1a(seed, input).toString(16).padStart(8, "0");
  }
  return hex;
}

export class DenoDurableObjectId {
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

/* ---------- storage ---------- */

export interface DenoDurableObjectStorage extends DurableSqlite {
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

function createStorage(
  db: SyncSqliteDatabaseLike,
  kv: DenoKvLike,
  className: string,
  idHex: string,
): DenoDurableObjectStorage {
  const base = createDurableSqlite(db);
  return {
    ...base,
    async setAlarm(scheduledTime: number | Date): Promise<void> {
      const time =
        typeof scheduledTime === "number"
          ? scheduledTime
          : scheduledTime.getTime();
      if (!Number.isFinite(time)) {
        throw new TypeError("setAlarm: scheduledTime must be a finite time");
      }
      await setAlarm(kv, className, idHex, time);
    },
    async getAlarm(): Promise<number | null> {
      return getAlarm(kv, className, idHex);
    },
    async deleteAlarm(): Promise<void> {
      await deleteAlarmKv(kv, className, idHex);
    },
  };
}

/* ---------- WebSockets ---------- */

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

class SocketSet {
  readonly #sockets = new Set<WebSocket>();
  #owner?: HibernationHandlers;

  _setOwner(owner: HibernationHandlers): void {
    this.#owner = owner;
  }

  accept(ws: WebSocket): void {
    this.#sockets.add(ws);
    const onMessage = (event: Event): void => {
      const data = (event as unknown as { data: string | ArrayBuffer }).data;
      void this.#owner?.webSocketMessage?.(ws, data);
    };
    const onError = (event: Event): void => {
      const error = ((event ?? {}) as { error?: unknown }).error;
      void this.#owner?.webSocketError?.(ws, error);
    };
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

  list(): WebSocket[] {
    return [...this.#sockets];
  }
}

/* ---------- state ---------- */

// `_Env` (not `Env`): the parameter exists so `DurableObject<Env>.ctx`'s type
// (`DenoDurableObjectState<Env>`) lines up with the DO subclass's `Env`, but
// nothing in this class's own body reads it yet — underscore-prefixed per
// this repo's unused-identifier convention (see CLAUDE.md "Conventions").
export class DenoDurableObjectState<_Env = unknown> {
  readonly id: DenoDurableObjectId;
  readonly storage: DenoDurableObjectStorage;
  readonly #sockets = new SocketSet();
  #concurrencyGate: Promise<unknown> = Promise.resolve();

  constructor(id: DenoDurableObjectId, storage: DenoDurableObjectStorage) {
    this.id = id;
    this.storage = storage;
  }

  _setOwner(owner: HibernationHandlers): void {
    this.#sockets._setOwner(owner);
  }

  get concurrencyGate(): Promise<unknown> {
    return this.#concurrencyGate;
  }

  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#concurrencyGate.then(fn);
    this.#concurrencyGate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  acceptWebSocket(ws: WebSocket): void {
    this.#sockets.accept(ws);
  }

  getWebSockets(): WebSocket[] {
    return this.#sockets.list();
  }
}

/* ---------- DurableObject base class ---------- */

export interface AlarmInvocationInfo {
  readonly retryCount: number;
  readonly isRetry: boolean;
}

export class DurableObject<Env = unknown> {
  protected ctx: DenoDurableObjectState<Env>;
  protected env: Env;

  alarm?(alarmInfo?: AlarmInvocationInfo): void | Promise<void>;

  constructor(ctx: DenoDurableObjectState<Env>, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export type DurableObjectClass<T> = new (state: never, env: never) => T;

/* ---------- namespace ---------- */

export interface DurableObjectNamespaceOptions<Env> {
  readonly kv: DenoKvLike;
  readonly className: string;
  readonly env: Env;
  /** Per-id libSQL embedded-replica client; called once per id, cached for
   *  the process's lifetime alongside the constructed instance. */
  readonly getStorageClient: (idHex: string) => SyncSqliteDatabaseLike;
  /**
   * Called once per dispatch — a `fetch()` or an about-to-run `alarm()` — after
   * the id's lease is acquired and before the event runs, with the same
   * `SyncSqliteDatabaseLike` instance `getStorageClient(idHex)` returned (cached
   * across dispatches for this id). This is the injection point for the
   * sync-before-serve rule: a different replica may have written to this id's
   * database since this instance last held the lease, so a composing host whose
   * concrete storage client also exposes a `sync()`-style method (e.g. the
   * `libsql` package's embedded-replica client) calls it here. This package takes
   * no dependency on any such method itself — `client` is typed as the plain
   * `SyncSqliteDatabaseLike` seam, and the callback narrows it to whatever richer
   * type the host's own `getStorageClient` actually constructs.
   */
  readonly onLeaseAcquired?: (
    idHex: string,
    client: SyncSqliteDatabaseLike,
  ) => Promise<void> | void;
  readonly leaseTtlMs?: number;
  readonly leaseAcquireTimeoutMs?: number;
}

interface StubLike {
  fetch(request: Request): Promise<Response>;
}

interface Instance<T> {
  readonly object: T;
  readonly state: DenoDurableObjectState;
  readonly db: SyncSqliteDatabaseLike;
  chain: Promise<unknown>;
}

const ALARM_RETRY_BASE_MS = 2_000;
const ALARM_RETRY_MAX = 6;

/**
 * A `DurableObjectNamespace` that routes `get(id).fetch(req)` to a per-id
 * `DurableObject` instance, serialised behind a KV lease (cross-process,
 * host-contract §3.3 rule 1) plus a local per-id promise chain
 * (same-process ordering).
 */
export class DurableObjectNamespaceLike<
  T extends { fetch(r: Request): Promise<Response> },
> {
  readonly #ctor: DurableObjectClass<T>;
  readonly #options: DurableObjectNamespaceOptions<unknown>;
  readonly #instances = new Map<string, Instance<T>>();
  readonly #leaseOptions: LeaseOptions;

  constructor(
    ctor: DurableObjectClass<T>,
    options: DurableObjectNamespaceOptions<unknown>,
  ) {
    this.#ctor = ctor;
    this.#options = options;
    this.#leaseOptions = {
      ttlMs: options.leaseTtlMs,
      acquireTimeoutMs: options.leaseAcquireTimeoutMs,
    };
  }

  idFromName(name: string): DenoDurableObjectId {
    return new DenoDurableObjectId(hashToHex(name), name);
  }

  idFromString(hex: string): DenoDurableObjectId {
    return new DenoDurableObjectId(hex);
  }

  newUniqueId(): DenoDurableObjectId {
    const random = `${Date.now()}:${Math.random()}:${Math.random()}`;
    return new DenoDurableObjectId(hashToHex(random));
  }

  get(id: DenoDurableObjectId): StubLike {
    return { fetch: (request: Request) => this.#dispatch(id, request) };
  }

  #leaseKey(idHex: string): KvKey {
    return ["dwk_lease", this.#options.className, idHex];
  }

  #materialize(id: DenoDurableObjectId): Instance<T> {
    const idHex = id.toString();
    let instance = this.#instances.get(idHex);
    if (instance === undefined) {
      const db = this.#options.getStorageClient(idHex);
      const storage = createStorage(
        db,
        this.#options.kv,
        this.#options.className,
        idHex,
      );
      const state = new DenoDurableObjectState(id, storage);
      const object = new this.#ctor(state as never, this.#options.env as never);
      state._setOwner(object as HibernationHandlers);
      instance = { object, state, db, chain: Promise.resolve() };
      this.#instances.set(idHex, instance);
    }
    return instance;
  }

  async #dispatch(
    id: DenoDurableObjectId,
    request: Request,
  ): Promise<Response> {
    const idHex = id.toString();
    const lease: Lease = await acquireLease(
      this.#options.kv,
      this.#leaseKey(idHex),
      this.#leaseOptions,
    );
    try {
      const instance = this.#materialize(id);
      // Sync-before-serve: a different replica may have written to this id's
      // database since this instance last held the lease (or since it was
      // constructed) — the hook is the injection point for pulling those
      // writes in before `fetch()` sees them. Runs after the lease is held so
      // nothing else can write underneath it before the event executes.
      await this.#options.onLeaseAcquired?.(idHex, instance.db);
      const run = instance.chain
        .then(() => instance.state.concurrencyGate)
        .then(() => instance.object.fetch(request));
      instance.chain = run.then(
        () => undefined,
        () => undefined,
      );
      return await run;
    } finally {
      try {
        await releaseLease(this.#options.kv, lease);
      } catch {
        // A release failure must not mask `run`'s real result/error above —
        // the lease's TTL is the crash safety net and frees it eventually.
      }
    }
  }

  /**
   * One scan-and-fire pass over this namespace's due alarms. Wire this to
   * whatever periodic trigger the composing app's runtime offers
   * (`Deno.cron()` on Deno Deploy) — the package never starts its own
   * timer.
   */
  async pollAlarms(
    options: { now?: number; batchSize?: number } = {},
  ): Promise<void> {
    const now = options.now ?? Date.now();
    const batchSize = options.batchSize ?? 100;
    const due = await listDueAlarms(
      this.#options.kv,
      this.#options.className,
      now,
      batchSize,
    );
    for (const entry of due) {
      const claimed = await claimDueAlarm(this.#options.kv, entry);
      if (!claimed) continue;
      await this.#fireAlarm(entry.idHex, entry.retryCount, entry.epochMs, now);
    }
  }

  async #fireAlarm(
    idHex: string,
    retryCount: number,
    epochMs: number,
    now: number,
  ): Promise<void> {
    const id = new DenoDurableObjectId(idHex);
    let lease: Lease | undefined;
    let handlerStarted = false;
    try {
      lease = await acquireLease(
        this.#options.kv,
        this.#leaseKey(idHex),
        this.#leaseOptions,
      );
      // Firing consumes the alarm slot: `claimDueAlarm` only removed the
      // due-index entry, so the by-id record (what `getAlarm`/`setAlarm`
      // read/write) still holds the pre-fire schedule. Clear it — but only
      // if it still matches what this invocation claimed: while this call
      // was waiting to acquire the lease, a concurrent fetch() holding the
      // lease could have legitimately rescheduled the alarm via
      // ctx.storage.setAlarm(). If so, this invocation is stale/superseded
      // — don't touch KV further and don't fire the handler; the new
      // schedule is untouched and a future poll will pick it up on its own.
      const stillClaimed = await clearClaimedAlarm(
        this.#options.kv,
        this.#options.className,
        idHex,
        epochMs,
        retryCount,
      );
      if (!stillClaimed) return;
      const instance = this.#materialize(id);
      // Same sync-before-serve rule as #dispatch (see its comment), applied
      // just before the handler actually runs — skipped above for a
      // superseded/no-op claim so an alarm that won't fire never pays for it.
      // A rejection here is not the handler's fault (the handler never got a
      // chance to run) — `handlerStarted` staying false routes it to the
      // same not-counted-against-the-retry-budget recovery as a lease
      // acquisition failure, below.
      await this.#options.onLeaseAcquired?.(idHex, instance.db);
      handlerStarted = true;
      const run = instance.chain
        .then(() => instance.state.concurrencyGate)
        .then(async () => {
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
      await run;
    } catch {
      if (lease === undefined) {
        // acquireLease itself threw (e.g. a concurrent fetch()/alarm() holds
        // this id's lease) — the handler never ran, and `claimDueAlarm`
        // already removed the due-index entry, so it must be restored or the
        // alarm is lost. Not the handler's fault, so this doesn't count
        // against the retry budget: re-post at `now` (immediately due) with
        // the same retryCount, so the next poll simply retries acquisition.
        await scheduleRetry(
          this.#options.kv,
          this.#options.className,
          idHex,
          now,
          retryCount,
        );
      } else if (!handlerStarted) {
        // The lease was acquired, but something before the handler ran threw
        // — in practice `onLeaseAcquired` (the sync-before-serve hook) or
        // `getStorageClient`/construction inside `#materialize`. Same
        // rationale as the `lease === undefined` branch above: the handler
        // never got a chance to run, so a transient failure here (e.g. the
        // primary is briefly unreachable) must not burn down the retry
        // budget — re-post at `now` with the same retryCount instead.
        await scheduleRetry(
          this.#options.kv,
          this.#options.className,
          idHex,
          now,
          retryCount,
        );
      } else if (retryCount < ALARM_RETRY_MAX) {
        // Exhausted retries are dropped; the handler owns its error
        // reporting (same posture as @dwk/cf-shims' alarm shim).
        const stillPending = await getAlarm(
          this.#options.kv,
          this.#options.className,
          idHex,
        );
        // A handler that set its own new alarm before throwing supersedes
        // the auto-retry — only schedule one if nothing is pending.
        if (stillPending === null) {
          const backoff = ALARM_RETRY_BASE_MS * 2 ** retryCount;
          await scheduleRetry(
            this.#options.kv,
            this.#options.className,
            idHex,
            now + backoff,
            retryCount + 1,
          );
        }
      }
    } finally {
      if (lease !== undefined) {
        try {
          await releaseLease(this.#options.kv, lease);
        } catch {
          // Same rationale as #dispatch: don't let a release failure mask
          // whatever this attempt already decided (fired, superseded, or
          // scheduled a retry above) — the lease TTL frees it eventually.
        }
      }
    }
  }
}

export function createDurableObjectNamespace<
  Env,
  T extends { fetch(r: Request): Promise<Response> },
>(
  ctor: DurableObjectClass<T>,
  options: DurableObjectNamespaceOptions<Env>,
): DurableObjectNamespaceLike<T> {
  return new DurableObjectNamespaceLike<T>(
    ctor,
    options as DurableObjectNamespaceOptions<unknown>,
  );
}
