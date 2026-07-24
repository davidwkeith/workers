import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { DurableObject } from "@dwk/deno-host";
import { createCentralDurableObjectNamespace } from "./central-durable-object.js";
import { LibsqlKv } from "./libsql-kv.js";
import {
  createFakeEmbeddedReplicaFactory,
  createFakeEmbeddedReplicaPrimaries,
  createFakeLibsqlClient,
} from "./central-test-harness.js";

function fakeKv(): LibsqlKv {
  return new LibsqlKv(createFakeLibsqlClient());
}

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

describe("createCentralDurableObjectNamespace (spec/scale-out.md §6.2)", () => {
  it("calls client.sync() before every fetch(), so a peer replica's prior write is visible", async () => {
    const kv = fakeKv();
    const primaries = createFakeEmbeddedReplicaPrimaries();
    const nsA = createCentralDurableObjectNamespace(CounterObject, {
      kv,
      className: "Counter",
      env: {},
      getStorageClient: createFakeEmbeddedReplicaFactory(primaries),
    });
    const nsB = createCentralDurableObjectNamespace(CounterObject, {
      kv,
      className: "Counter",
      env: {},
      getStorageClient: createFakeEmbeddedReplicaFactory(primaries),
    });
    const idA = nsA.idFromName("alice");
    const idB = nsB.idFromName("alice");

    expect(
      await (await nsA.get(idA).fetch(new Request("http://x/"))).text(),
    ).toBe("1");
    // Replica B has never touched this id before; its dispatch must sync
    // from the shared primary before reading — without the sync-before-serve
    // hook it would see an empty (never-synced) local database and fail on
    // the CREATE-then-read below, or start its own counter back at 1.
    expect(
      await (await nsB.get(idB).fetch(new Request("http://x/"))).text(),
    ).toBe("2");
    expect(
      await (await nsA.get(idA).fetch(new Request("http://x/"))).text(),
    ).toBe("3");
  });

  it("propagates a sync() rejection instead of running fetch()", async () => {
    const kv = fakeKv();
    let fetchRan = false;
    class TrackedObject extends DurableObject<Record<string, never>> {
      async fetch(): Promise<Response> {
        fetchRan = true;
        return new Response("ok");
      }
    }
    const ns = createCentralDurableObjectNamespace(TrackedObject, {
      kv,
      className: "Tracked",
      env: {},
      getStorageClient: () => ({
        exec: () => undefined,
        prepare: () => ({ all: () => [], run: () => ({ changes: 0 }) }),
        sync: async () => {
          throw new Error("primary unreachable");
        },
      }),
    });
    await expect(
      ns.get(ns.idFromName("alice")).fetch(new Request("http://x/")),
    ).rejects.toThrow("primary unreachable");
    expect(fetchRan).toBe(false);
  });

  it("logs sync duration on success and a warning on sync failure (spec/scale-out.md §12, #433)", async () => {
    const kv = fakeKv();
    const debugs: Array<[string, Record<string, unknown>]> = [];
    const warnings: Array<[string, Record<string, unknown>]> = [];
    const logger = {
      debug: (event: string, fields?: Record<string, unknown>) =>
        debugs.push([event, fields ?? {}]),
      info: () => {},
      warn: (event: string, fields?: Record<string, unknown>) =>
        warnings.push([event, fields ?? {}]),
      error: () => {},
    };

    class OkObject extends DurableObject<Record<string, never>> {
      async fetch(): Promise<Response> {
        return new Response("ok");
      }
    }
    const ok = createCentralDurableObjectNamespace(OkObject, {
      kv,
      className: "Ok",
      env: {},
      getStorageClient: createFakeEmbeddedReplicaFactory(
        createFakeEmbeddedReplicaPrimaries(),
      ),
      logger,
    });
    await ok.get(ok.idFromName("alice")).fetch(new Request("http://x/"));
    expect(debugs).toHaveLength(1);
    expect(debugs[0]?.[0]).toBe("central_do.sync_duration_ms");
    expect(debugs[0]?.[1]?.["className"]).toBe("Ok");
    expect(typeof debugs[0]?.[1]?.["durationMs"]).toBe("number");

    class FailingSyncObject extends DurableObject<Record<string, never>> {
      async fetch(): Promise<Response> {
        return new Response("ok");
      }
    }
    const failing = createCentralDurableObjectNamespace(FailingSyncObject, {
      kv,
      className: "Failing",
      env: {},
      getStorageClient: () => ({
        exec: () => undefined,
        prepare: () => ({ all: () => [], run: () => ({ changes: 0 }) }),
        sync: async () => {
          throw new Error("primary unreachable");
        },
      }),
      logger,
    });
    await expect(
      failing.get(failing.idFromName("alice")).fetch(new Request("http://x/")),
    ).rejects.toThrow("primary unreachable");
    expect(warnings).toEqual([
      [
        "central_do.sync_error",
        {
          className: "Failing",
          idHex: failing.idFromName("alice").toString(),
          error: "primary unreachable",
        },
      ],
    ]);
  });

  it("fake embedded-replica client: writes land on the shared primary immediately, reads stay local until sync()", () => {
    const primaries = createFakeEmbeddedReplicaPrimaries();
    const factory = createFakeEmbeddedReplicaFactory(primaries);
    const a = factory("shared");
    a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    a.prepare("INSERT INTO t (id, v) VALUES (1, 'from-a')").run();

    const b = factory("shared");
    // b has never synced: its local file has no table at all yet.
    expect(() => b.prepare("SELECT * FROM t").all()).toThrow();

    const primary = primaries.get("shared") as DatabaseSync;
    expect(primary.prepare("SELECT v FROM t WHERE id = 1").get()).toEqual({
      v: "from-a",
    });
  });
});
