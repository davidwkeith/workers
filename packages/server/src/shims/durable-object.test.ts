import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DurableObject,
  createDurableObjectNamespace,
  type AlarmInvocationInfo,
  type DurableObjectState,
} from "./durable-object.js";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "dwk-do-"));
}

/** A tiny DO that uses SqlStorage + serialises a read-modify-write counter. */
class Counter extends DurableObject {
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.#state = state;
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS c (k TEXT PRIMARY KEY, n INTEGER)",
    );
    state.storage.sql.exec(
      "INSERT OR IGNORE INTO c (k, n) VALUES ('count', 0)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/inc") {
      // A non-atomic read-then-write: only correct if calls are serialised.
      const { n } = this.#state.storage.sql
        .exec<{ n: number }>("SELECT n FROM c WHERE k = 'count'")
        .one();
      await new Promise((r) => setTimeout(r, 1)); // widen the race window
      this.#state.storage.sql.exec(
        "UPDATE c SET n = ? WHERE k = 'count'",
        n + 1,
      );
      return new Response(String(n + 1));
    }
    if (url.pathname === "/id") {
      return new Response(this.#state.id.toString());
    }
    return new Response("ok");
  }
}

type Listener = (event: Event) => void;

/** A fake hibernatable WebSocket so close/error/message events can be fired. */
function fakeWebSocket(): WebSocket & {
  fire(type: string, props?: Record<string, unknown>): void;
} {
  const listeners = new Map<string, Listener[]>();
  return {
    addEventListener(type: string, cb: Listener) {
      const list = listeners.get(type) ?? [];
      list.push(cb);
      listeners.set(type, list);
    },
    removeEventListener(type: string, cb: Listener) {
      const list = listeners.get(type);
      if (list)
        listeners.set(
          type,
          list.filter((x) => x !== cb),
        );
    },
    fire(type: string, props: Record<string, unknown> = {}) {
      const event = Object.assign(new Event(type), props);
      for (const cb of [...(listeners.get(type) ?? [])]) cb(event);
    },
  } as unknown as WebSocket & {
    fire(type: string, props?: Record<string, unknown>): void;
  };
}

/** Exercises the full SqlStorage / state surface so each method is covered. */
class Kitchen extends DurableObject {
  ready = false;
  errors = 0;
  readonly #state: DurableObjectState;

  webSocketError(): void {
    this.errors += 1;
  }

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.#state = state;
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (k TEXT, v)");
    // Async initialisation gated by blockConcurrencyWhile — the namespace must
    // hold the first request until this resolves.
    void state.blockConcurrencyWhile(async () => {
      await new Promise((r) => setTimeout(r, 10));
      state.storage.sql.exec("INSERT INTO t (k, v) VALUES ('ready', 1)");
      this.ready = true;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const sql = this.#state.storage.sql;
    switch (new URL(request.url).pathname) {
      case "/ready":
        return json({ ready: this.ready });
      case "/tx-commit":
        this.#state.storage.transactionSync(() =>
          sql.exec("INSERT INTO t (k, v) VALUES ('a', 1)"),
        );
        await this.#state.storage.transaction(async () =>
          sql.exec("INSERT INTO t (k, v) VALUES ('b', 2)"),
        );
        return json({
          n: sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM t").one().n,
        });
      case "/tx-rollback": {
        try {
          this.#state.storage.transactionSync(() => {
            sql.exec("INSERT INTO t (k, v) VALUES ('c', 3)");
            throw new Error("boom");
          });
        } catch {
          /* rolled back */
        }
        try {
          await this.#state.storage.transaction(async () => {
            sql.exec("INSERT INTO t (k, v) VALUES ('d', 4)");
            throw new Error("boom");
          });
        } catch {
          /* rolled back */
        }
        const rows = sql
          .exec("SELECT k FROM t WHERE k IN ('c', 'd')")
          .toArray();
        return json({ leaked: rows.length });
      }
      case "/cursor": {
        const cursor = sql.exec("SELECT k, v FROM t");
        let iterated = 0;
        for (const _ of cursor) iterated += 1;
        return json({
          columnNames: cursor.columnNames,
          empty: sql.exec("SELECT k FROM t WHERE k = 'nope'").columnNames,
          size: sql.databaseSize,
          iterated,
        });
      }
      case "/bind": {
        sql.exec("CREATE TABLE IF NOT EXISTS b (x, y, z)");
        sql.exec(
          "INSERT INTO b (x, y, z) VALUES (?, ?, ?)",
          true,
          new ArrayBuffer(2),
          new Uint8Array([1, 2]),
        );
        let threw = "";
        try {
          sql.exec("SELECT ?", Symbol("nope") as unknown);
        } catch (e) {
          threw = (e as Error).name;
        }
        return json({ threw });
      }
      case "/ws": {
        const ws = fakeWebSocket();
        this.#state.acceptWebSocket(ws);
        const accepted = this.#state.getWebSockets().length;
        ws.fire("close", { code: 1000, wasClean: true });
        const afterClose = this.#state.getWebSockets().length;
        // An error invokes webSocketError but does not drop the socket.
        const errored = fakeWebSocket();
        this.#state.acceptWebSocket(errored);
        errored.fire("error", { error: new Error("boom") });
        const afterError = this.#state.getWebSockets().length;
        return json({ accepted, afterClose, afterError, errors: this.errors });
      }
      default:
        return new Response("ok");
    }
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function counterNs() {
  return createDurableObjectNamespace(Counter, {
    dataDir: dataDir(),
    env: {},
    className: "counter",
  });
}

function kitchenNs() {
  return createDurableObjectNamespace(Kitchen, {
    dataDir: dataDir(),
    env: {},
    className: "kitchen",
  });
}

describe("Durable Object emulation", () => {
  it("exposes SqlStorage with exec().one()/.toArray()", async () => {
    const ns = counterNs();
    const s = ns.get(ns.idFromName("a"));
    expect(await (await s.fetch(new Request("http://do/inc"))).text()).toBe(
      "1",
    );
    expect(await (await s.fetch(new Request("http://do/inc"))).text()).toBe(
      "2",
    );
  });

  it("serialises concurrent requests to one id (single-writer guarantee)", async () => {
    const ns = counterNs();
    const id = ns.idFromName("pod-1");
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        ns.get(id).fetch(new Request("http://do/inc")),
      ),
    );
    const values = (await Promise.all(results.map((r) => r.text())))
      .map(Number)
      .sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("isolates state per object id (separate SQLite files)", async () => {
    const ns = counterNs();
    await ns.get(ns.idFromName("x")).fetch(new Request("http://do/inc"));
    await ns.get(ns.idFromName("x")).fetch(new Request("http://do/inc"));
    const y = await ns
      .get(ns.idFromName("y"))
      .fetch(new Request("http://do/inc"));
    expect(await y.text()).toBe("1");
  });

  it("mints/parses ids: stable from name, from string, and unique", () => {
    const ns = counterNs();
    const a1 = ns.idFromName("https://example.com");
    const a2 = ns.idFromName("https://example.com");
    expect(a1.toString()).toBe(a2.toString());
    expect(a1.toString()).toMatch(/^[0-9a-f]{64}$/);
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(ns.idFromName("https://other.example"))).toBe(false);
    expect(ns.idFromString("deadbeef").toString()).toBe("deadbeef");
    expect(ns.newUniqueId().toString()).not.toBe(ns.newUniqueId().toString());
  });

  it("holds the first request until blockConcurrencyWhile init resolves", async () => {
    const ns = kitchenNs();
    // The very first request must observe the async-initialised state.
    const res = await ns
      .get(ns.idFromName("k"))
      .fetch(new Request("http://do/ready"));
    expect((await res.json()) as { ready: boolean }).toEqual({ ready: true });
  });

  it("commits and rolls back transactions (sync and async)", async () => {
    const ns = kitchenNs();
    const id = ns.idFromName("k");
    const commit = await ns.get(id).fetch(new Request("http://do/tx-commit"));
    // 'ready' (from init) + 'a' + 'b'
    expect((await commit.json()) as { n: number }).toEqual({ n: 3 });
    const rb = await ns.get(id).fetch(new Request("http://do/tx-rollback"));
    expect((await rb.json()) as { leaked: number }).toEqual({ leaked: 0 });
  });

  it("supports the cursor surface (columnNames, iteration, databaseSize)", async () => {
    const ns = kitchenNs();
    const res = await ns
      .get(ns.idFromName("k"))
      .fetch(new Request("http://do/cursor"));
    const body = (await res.json()) as {
      columnNames: string[];
      empty: string[];
      size: number;
      iterated: number;
    };
    expect(body.columnNames).toEqual(["k", "v"]);
    expect(body.empty).toEqual([]);
    expect(body.size).toBe(0);
    expect(body.iterated).toBeGreaterThan(0);
  });

  it("normalises bind values and rejects unsupported ones", async () => {
    const ns = kitchenNs();
    const res = await ns
      .get(ns.idFromName("k"))
      .fetch(new Request("http://do/bind"));
    expect((await res.json()) as { threw: string }).toEqual({
      threw: "TypeError",
    });
  });

  it("drops sockets on close and routes errors to webSocketError", async () => {
    const ns = kitchenNs();
    const res = await ns
      .get(ns.idFromName("k"))
      .fetch(new Request("http://do/ws"));
    expect(
      (await res.json()) as {
        accepted: number;
        afterClose: number;
        afterError: number;
        errors: number;
      },
    ).toEqual({ accepted: 1, afterClose: 0, afterError: 1, errors: 1 });
  });
});

/** Per-test alarm behaviour + a shared invocation log, injected via `env`. */
type AlarmEnv = {
  log: Array<{
    retryCount: number;
    isRetry: boolean;
    /** What `getAlarm()` returned inside the handler (null unless re-armed). */
    pending: number | null;
  }>;
  /** Throw from `alarm()` this many times before succeeding. */
  failTimes?: number;
  /** Before throwing, re-arm the alarm this far in the future (supersedes retry). */
  rearmOnFailInMs?: number;
};

/** A DO whose alarm() records its invocations; armed/read/cancelled via fetch. */
class Alarmed extends DurableObject<AlarmEnv> {
  readonly #state: DurableObjectState;
  readonly #alarmEnv: AlarmEnv;

  constructor(state: DurableObjectState, env: AlarmEnv) {
    super(state, env);
    this.#state = state;
    this.#alarmEnv = env;
  }

  override async alarm(info?: AlarmInvocationInfo): Promise<void> {
    this.#alarmEnv.log.push({
      retryCount: info?.retryCount ?? -1,
      isRetry: info?.isRetry ?? false,
      pending: await this.#state.storage.getAlarm(),
    });
    if ((this.#alarmEnv.failTimes ?? 0) > 0) {
      this.#alarmEnv.failTimes = (this.#alarmEnv.failTimes ?? 0) - 1;
      if (this.#alarmEnv.rearmOnFailInMs !== undefined) {
        await this.#state.storage.setAlarm(
          Date.now() + this.#alarmEnv.rearmOnFailInMs,
        );
      }
      throw new Error("alarm boom");
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const storage = this.#state.storage;
    switch (url.pathname) {
      case "/arm": {
        const inMs = Number(url.searchParams.get("in") ?? "0");
        await storage.setAlarm(Date.now() + inMs);
        return json({ scheduled: await storage.getAlarm() });
      }
      case "/get":
        return json({ scheduled: await storage.getAlarm() });
      case "/del": {
        await storage.deleteAlarm();
        return json({ scheduled: await storage.getAlarm() });
      }
      default:
        return new Response("ok");
    }
  }
}

function alarmedNs(
  env: AlarmEnv,
  options: {
    dataDir?: string;
    alarmRetry?: { maxRetries?: number; baseDelayMs?: number };
  } = {},
) {
  return createDurableObjectNamespace(Alarmed, {
    dataDir: options.dataDir ?? dataDir(),
    env: env as unknown as Record<string, unknown>,
    className: "alarmed",
    ...(options.alarmRetry ? { alarmRetry: options.alarmRetry } : {}),
  });
}

describe("Durable Object alarms", () => {
  it("persists setAlarm/getAlarm/deleteAlarm without firing early", async () => {
    const env: AlarmEnv = { log: [] };
    const ns = alarmedNs(env);
    const stub = ns.get(ns.idFromName("a"));
    const far = Date.now() + 60_000;
    expect(
      await (await stub.fetch(new Request("http://do/get"))).json(),
    ).toEqual({ scheduled: null });
    const armed = (await (
      await stub.fetch(new Request(`http://do/arm?in=60000`))
    ).json()) as { scheduled: number };
    expect(armed.scheduled).toBeGreaterThanOrEqual(far - 1000);
    expect(
      await (await stub.fetch(new Request("http://do/del"))).json(),
    ).toEqual({ scheduled: null });
    expect(env.log).toHaveLength(0);
    ns.dispose();
  });

  it("fires alarm() at the scheduled time, deleting the alarm first", async () => {
    const env: AlarmEnv = { log: [] };
    const ns = alarmedNs(env);
    const stub = ns.get(ns.idFromName("a"));
    await stub.fetch(new Request("http://do/arm?in=15"));
    await vi.waitFor(() => expect(env.log).toHaveLength(1), { timeout: 2000 });
    // The alarm was deleted before the handler ran (Cloudflare's contract),
    // and stays deleted after a successful run.
    expect(env.log[0]).toEqual({
      retryCount: 0,
      isRetry: false,
      pending: null,
    });
    expect(
      await (await stub.fetch(new Request("http://do/get"))).json(),
    ).toEqual({ scheduled: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(env.log).toHaveLength(1);
    ns.dispose();
  });

  it("replaces a pending alarm on a later setAlarm (one alarm per object)", async () => {
    const env: AlarmEnv = { log: [] };
    const ns = alarmedNs(env);
    const stub = ns.get(ns.idFromName("a"));
    await stub.fetch(new Request("http://do/arm?in=60000"));
    await stub.fetch(new Request("http://do/arm?in=15"));
    await vi.waitFor(() => expect(env.log).toHaveLength(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(env.log).toHaveLength(1);
    ns.dispose();
  });

  it("deleteAlarm cancels a pending alarm", async () => {
    const env: AlarmEnv = { log: [] };
    const ns = alarmedNs(env);
    const stub = ns.get(ns.idFromName("a"));
    await stub.fetch(new Request("http://do/arm?in=20"));
    await stub.fetch(new Request("http://do/del"));
    await new Promise((r) => setTimeout(r, 80));
    expect(env.log).toHaveLength(0);
    ns.dispose();
  });

  it("retries a throwing handler with backoff and retry metadata", async () => {
    const env: AlarmEnv = { log: [], failTimes: 2 };
    const ns = alarmedNs(env, {
      alarmRetry: { maxRetries: 5, baseDelayMs: 5 },
    });
    await ns.get(ns.idFromName("a")).fetch(new Request("http://do/arm?in=0"));
    await vi.waitFor(() => expect(env.log).toHaveLength(3), { timeout: 2000 });
    expect(env.log.map((e) => e.retryCount)).toEqual([0, 1, 2]);
    expect(env.log.map((e) => e.isRetry)).toEqual([false, true, true]);
    await new Promise((r) => setTimeout(r, 60));
    expect(env.log).toHaveLength(3); // succeeded on the third attempt — no more
    ns.dispose();
  });

  it("gives up after the configured retry cap", async () => {
    const env: AlarmEnv = { log: [], failTimes: 99 };
    const ns = alarmedNs(env, {
      alarmRetry: { maxRetries: 2, baseDelayMs: 5 },
    });
    await ns.get(ns.idFromName("a")).fetch(new Request("http://do/arm?in=0"));
    // 1 initial attempt + 2 retries, then dropped.
    await vi.waitFor(() => expect(env.log).toHaveLength(3), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 60));
    expect(env.log).toHaveLength(3);
    ns.dispose();
  });

  it("lets an alarm set by a failing handler supersede the retry", async () => {
    const env: AlarmEnv = { log: [], failTimes: 1, rearmOnFailInMs: 15 };
    const ns = alarmedNs(env, {
      alarmRetry: { maxRetries: 5, baseDelayMs: 60_000 },
    });
    await ns.get(ns.idFromName("a")).fetch(new Request("http://do/arm?in=0"));
    // With a 60 s retry backoff, a second invocation this soon can only be the
    // superseding alarm the failing handler set — delivered as a fresh attempt.
    await vi.waitFor(() => expect(env.log).toHaveLength(2), { timeout: 2000 });
    expect(env.log.map((e) => e.retryCount)).toEqual([0, 0]);
    ns.dispose();
  });

  it("re-arms a persisted past-due alarm on construction (restart recovery)", async () => {
    const dir = dataDir();
    const key = "ab12cd34";
    const objectDir = join(dir, "do", "alarmed");
    mkdirSync(objectDir, { recursive: true });
    // Simulate a previous process that persisted an alarm and then died.
    const db = new DatabaseSync(join(objectDir, `${key}.sqlite`));
    db.exec(
      "CREATE TABLE IF NOT EXISTS _host_alarm " +
        "(id INTEGER PRIMARY KEY CHECK (id = 1), scheduled_time INTEGER NOT NULL)",
    );
    db.prepare(
      "INSERT INTO _host_alarm (id, scheduled_time) VALUES (1, ?)",
    ).run(Date.now() - 1000);
    db.close();
    const env: AlarmEnv = { log: [] };
    const ns = alarmedNs(env, { dataDir: dir });
    // Fires without any fetch ever touching the object in this "process".
    await vi.waitFor(() => expect(env.log).toHaveLength(1), { timeout: 2000 });
    expect(env.log[0]).toEqual({
      retryCount: 0,
      isRetry: false,
      pending: null,
    });
    ns.dispose();
  });

  it("re-arms a persisted future alarm at its scheduled time", async () => {
    const dir = dataDir();
    const env1: AlarmEnv = { log: [] };
    const ns1 = alarmedNs(env1, { dataDir: dir });
    const stub = ns1.get(ns1.idFromName("a"));
    await stub.fetch(new Request("http://do/arm?in=60000"));
    ns1.dispose(); // "restart": timers gone, the persisted time survives
    const env2: AlarmEnv = { log: [] };
    const ns2 = alarmedNs(env2, { dataDir: dir });
    await new Promise((r) => setTimeout(r, 30));
    expect(env2.log).toHaveLength(0); // future alarm must not fire early
    // Re-arm it sooner through the recovered namespace and watch it fire.
    await ns2
      .get(ns2.idFromName("a"))
      .fetch(new Request("http://do/arm?in=15"));
    await vi.waitFor(() => expect(env2.log).toHaveLength(1), { timeout: 2000 });
    ns1.dispose();
    ns2.dispose();
  });
});
