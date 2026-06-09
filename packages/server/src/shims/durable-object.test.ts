import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableObject,
  createDurableObjectNamespace,
  type DurableObjectState,
} from "./durable-object";

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

/** A fake hibernatable WebSocket recording listeners so close can be fired. */
function fakeWebSocket(): WebSocket & { fire(type: string): void } {
  const listeners = new Map<string, Array<() => void>>();
  return {
    addEventListener(type: string, cb: () => void) {
      const list = listeners.get(type) ?? [];
      list.push(cb);
      listeners.set(type, list);
    },
    fire(type: string) {
      for (const cb of listeners.get(type) ?? []) cb();
    },
  } as unknown as WebSocket & { fire(type: string): void };
}

/** Exercises the full SqlStorage / state surface so each method is covered. */
class Kitchen extends DurableObject {
  ready = false;
  readonly #state: DurableObjectState;

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
        const before = this.#state.getWebSockets().length;
        ws.fire("close");
        const errored = fakeWebSocket();
        this.#state.acceptWebSocket(errored);
        errored.fire("error");
        const after = this.#state.getWebSockets().length;
        return json({ before, after });
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

  it("tracks accepted WebSockets and drops them on close/error", async () => {
    const ns = kitchenNs();
    const res = await ns
      .get(ns.idFromName("k"))
      .fetch(new Request("http://do/ws"));
    expect((await res.json()) as { before: number; after: number }).toEqual({
      before: 1,
      after: 0,
    });
  });
});
