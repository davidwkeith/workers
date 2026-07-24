import { describe, it, expect } from "vitest";
import {
  createDurableObjectNamespace,
  DurableObject,
} from "./durable-object.js";
import { FakeDenoKv, createStrictSyncSqlite } from "./test-harness.js";

class CounterObject extends DurableObject<Record<string, never>> {
  async fetch(): Promise<Response> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO counter (id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = n + 1",
    );
    const n = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT n FROM counter WHERE id = 1")
      .one().n;
    return new Response(String(n));
  }
}

describe("createDurableObjectNamespace (host-contract §3.3)", () => {
  it("dispatches fetch() and persists state across requests for the same id", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    const ns = createDurableObjectNamespace(CounterObject, {
      kv,
      className: "Counter",
      env: {},
      getStorageClient: () => db,
    });
    const stub = ns.get(ns.idFromName("alice"));
    expect(await (await stub.fetch(new Request("http://x/"))).text()).toBe("1");
    expect(await (await stub.fetch(new Request("http://x/"))).text()).toBe("2");
  });

  it("idFromName is deterministic and distinct names hash differently", () => {
    const kv = new FakeDenoKv();
    const ns = createDurableObjectNamespace(CounterObject, {
      kv,
      className: "Counter",
      env: {},
      getStorageClient: () => createStrictSyncSqlite(),
    });
    expect(ns.idFromName("alice").toString()).toBe(
      ns.idFromName("alice").toString(),
    );
    expect(ns.idFromName("alice").toString()).not.toBe(
      ns.idFromName("bob").toString(),
    );
  });

  it("enforces single-writer across two namespaces sharing one KV, and releases the lease after completion", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    class SlowObject extends DurableObject<Record<string, never>> {
      async fetch(): Promise<Response> {
        await gate;
        return new Response("done");
      }
    }
    const makeNs = (leaseAcquireTimeoutMs?: number) =>
      createDurableObjectNamespace(SlowObject, {
        kv,
        className: "Slow",
        env: {},
        getStorageClient: () => db,
        leaseAcquireTimeoutMs,
      });
    const ns1 = makeNs();
    const ns2 = makeNs(100);
    const id = ns1.idFromName("shared");
    const inFlight = ns1.get(id).fetch(new Request("http://x/"));
    await new Promise((r) => setTimeout(r, 10)); // let ns1 acquire the lease
    await expect(
      ns2.get(ns2.idFromName("shared")).fetch(new Request("http://x/")),
    ).rejects.toThrow("lease contended");
    releaseFirst();
    expect(await (await inFlight).text()).toBe("done");
    // The lease is now free — proves release() actually ran.
    expect(
      await (
        await ns2.get(ns2.idFromName("shared")).fetch(new Request("http://x/"))
      ).text(),
    ).toBe("done");
  });

  it("calls onLeaseAcquired once per dispatch, after the lease and before fetch() runs, with the id's cached storage client", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    const calls: string[] = [];
    const ns = createDurableObjectNamespace(CounterObject, {
      kv,
      className: "Counter",
      env: {},
      getStorageClient: () => db,
      onLeaseAcquired: (idHex, client) => {
        calls.push(idHex);
        expect(client).toBe(db);
      },
    });
    const id = ns.idFromName("alice");
    await ns.get(id).fetch(new Request("http://x/"));
    await ns.get(id).fetch(new Request("http://x/"));
    expect(calls).toEqual([id.toString(), id.toString()]);
  });

  it("propagates an onLeaseAcquired rejection instead of running fetch(), and still releases the lease", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    let fetchRan = false;
    class TrackedObject extends DurableObject<Record<string, never>> {
      async fetch(): Promise<Response> {
        fetchRan = true;
        return new Response("ok");
      }
    }
    const ns = createDurableObjectNamespace(TrackedObject, {
      kv,
      className: "Tracked",
      env: {},
      getStorageClient: () => db,
      onLeaseAcquired: () => {
        throw new Error("sync failed");
      },
    });
    const id = ns.idFromName("alice");
    await expect(ns.get(id).fetch(new Request("http://x/"))).rejects.toThrow(
      "sync failed",
    );
    expect(fetchRan).toBe(false);
    // The lease was released despite the rejection — a subsequent dispatch
    // (with a working hook this time) is not stuck contending it.
    const ns2 = createDurableObjectNamespace(TrackedObject, {
      kv,
      className: "Tracked",
      env: {},
      getStorageClient: () => db,
    });
    expect(
      await (
        await ns2.get(ns2.idFromName("alice")).fetch(new Request("http://x/"))
      ).text(),
    ).toBe("ok");
  });

  it("dispatches accepted WebSocket events to the instance's overrides", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    type Listener = (event: Event) => void;
    function fakeWebSocket(): WebSocket & {
      fire(type: string, props?: Record<string, unknown>): void;
    } {
      const listeners = new Map<string, Listener[]>();
      return {
        addEventListener(type: string, cb: EventListenerOrEventListenerObject) {
          const list = listeners.get(type) ?? [];
          list.push(cb as Listener);
          listeners.set(type, list);
        },
        removeEventListener(
          type: string,
          cb: EventListenerOrEventListenerObject,
        ) {
          const list = listeners.get(type);
          if (list) {
            listeners.set(
              type,
              list.filter((x) => x !== (cb as Listener)),
            );
          }
        },
        fire(type: string, props: Record<string, unknown> = {}) {
          for (const cb of listeners.get(type) ?? []) {
            cb({ type, ...props } as unknown as Event);
          }
        },
      } as unknown as WebSocket & {
        fire(type: string, props?: Record<string, unknown>): void;
      };
    }

    const received: string[] = [];
    class SocketObject extends DurableObject<Record<string, never>> {
      async fetch(request: Request): Promise<Response> {
        if (new URL(request.url).pathname === "/ws") {
          const ws = fakeWebSocket();
          this.ctx.acceptWebSocket(ws);
          const accepted = this.ctx.getWebSockets().length;
          ws.fire("message", { data: "hello" });
          ws.fire("close", { code: 1000, wasClean: true });
          const afterClose = this.ctx.getWebSockets().length;
          return new Response(JSON.stringify({ accepted, afterClose }));
        }
        return new Response("ok");
      }
      webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): void {
        received.push(String(message));
      }
    }
    const ns = createDurableObjectNamespace(SocketObject, {
      kv,
      className: "Socket",
      env: {},
      getStorageClient: () => db,
    });
    const res = await ns
      .get(ns.idFromName("room"))
      .fetch(new Request("http://x/ws"));
    expect(await res.json()).toEqual({ accepted: 1, afterClose: 0 });
    expect(received).toEqual(["hello"]);
  });
});
