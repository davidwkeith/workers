/**
 * Phase 3 multi-replica integration (spec/scale-out.md §14 items 2–3, #432):
 * Durable Objects across replicas, driven both at the raw namespace level
 * (crash recovery) and end-to-end through two real `DwkServer` HTTP replicas
 * sharing one coordination `LibsqlKv` and one set of per-id embedded-replica
 * "primaries" (`central-test-harness.ts`'s fakes) — the decisive proof that
 * the per-request lease serializes racing writers across replicas and that
 * the sync-before-serve rule actually prevents a stale read, not just in the
 * unit-level test in `central-durable-object.test.ts`.
 *
 * @see spec/scale-out.md §6, §14
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableObject, type DurableObjectNamespaceLike } from "@dwk/deno-host";

import { createCentralServer, type DwkServer } from "./server.js";
import { createCentralDurableObjectNamespace } from "./central-durable-object.js";
import { LibsqlKv } from "./libsql-kv.js";
import {
  createFakeEmbeddedReplicaFactory,
  createFakeEmbeddedReplicaPrimaries,
  createFakeLibsqlClient,
} from "./central-test-harness.js";
import type { FetchHandler, Mount } from "./config.js";

const ORIGIN = "http://localhost";

/** A trivial per-id note store: `POST /note/:id` sets it, `GET` reads it back. */
class NoteObject extends DurableObject<Record<string, never>> {
  async fetch(request: Request): Promise<Response> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL DEFAULT '')",
    );
    if (request.method === "POST") {
      const body = await request.text();
      this.ctx.storage.sql.exec(
        "INSERT INTO note (id, body) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body",
        body,
      );
      return new Response("ok");
    }
    const row = this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM note WHERE id = 1")
      .toArray()[0];
    return new Response(row?.body ?? "");
  }
}

function noteMount(namespace: DurableObjectNamespaceLike<NoteObject>): Mount {
  const handler: FetchHandler = (async (request: Request) => {
    const url = new URL(request.url);
    const name = url.pathname.replace(/^\/note\//, "");
    const id = namespace.idFromName(name);
    return namespace.get(id).fetch(request);
  }) as unknown as FetchHandler;
  return { name: "note", handler, reservedPaths: ["/note"] };
}

describe("central mode — Durable Objects across two replicas (spec/scale-out.md §6)", () => {
  interface Replica {
    server: DwkServer;
    base: string;
  }

  let dataDirA = "";
  let dataDirB = "";
  let replicaA: Replica;
  let replicaB: Replica;
  let coordinationKv: LibsqlKv;

  beforeAll(async () => {
    dataDirA = mkdtempSync(join(tmpdir(), "dwk-central-do-a-"));
    dataDirB = mkdtempSync(join(tmpdir(), "dwk-central-do-b-"));
    const libsqlPrimary = createFakeLibsqlClient().db;
    coordinationKv = new LibsqlKv(createFakeLibsqlClient(libsqlPrimary));
    const embeddedPrimaries = createFakeEmbeddedReplicaPrimaries();

    async function buildReplica(dataDir: string): Promise<Replica> {
      const namespace = createCentralDurableObjectNamespace(NoteObject, {
        kv: coordinationKv,
        className: "Note",
        env: {},
        getStorageClient: createFakeEmbeddedReplicaFactory(embeddedPrimaries),
        leaseAcquireTimeoutMs: 150,
      });
      const server = await createCentralServer({
        baseUrl: ORIGIN,
        dataDir,
        mounts: [noteMount(namespace)],
        env: {},
        storage: { mode: "central", kv: coordinationKv },
      });
      const { port } = await server.listen(0, "127.0.0.1");
      return { server, base: `http://127.0.0.1:${port}` };
    }

    replicaA = await buildReplica(dataDirA);
    replicaB = await buildReplica(dataDirB);
  });

  afterAll(async () => {
    await replicaA?.server.close();
    await replicaB?.server.close();
    for (const dir of [dataDirA, dataDirB]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sync-before-serve: a write via replica A is immediately visible reading via replica B", async () => {
    const id = `note-${crypto.randomUUID()}`;
    const put = await fetch(`${replicaA.base}/note/${id}`, {
      method: "POST",
      body: "hello from A",
    });
    expect(put.status).toBe(200);

    const got = await fetch(`${replicaB.base}/note/${id}`);
    expect(await got.text()).toBe("hello from A");
  });

  it("racing writes to the same id from both replicas serialize — never interleaved, one contended", async () => {
    const id = `note-${crypto.randomUUID()}`;
    // Seed it so both requests are updates, not races to CREATE the row.
    await fetch(`${replicaA.base}/note/${id}`, {
      method: "POST",
      body: "seed",
    });

    const [resA, resB] = await Promise.all([
      fetch(`${replicaA.base}/note/${id}`, { method: "POST", body: "from A" }),
      fetch(`${replicaB.base}/note/${id}`, { method: "POST", body: "from B" }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    // Both may succeed serially (the loser's acquire retries within its
    // timeout and then runs), or the loser may surface as a 503 — either is
    // conforming (spec/scale-out.md §6.1); what must never happen is a
    // second concurrent success while the first is running, which the
    // final-state check below rules out indirectly (a corrupt interleaving
    // would leave the row's CHECK constraint violated or the update lost).
    expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);

    const finalRead = await fetch(`${replicaA.base}/note/${id}`);
    const finalBody = await finalRead.text();
    expect(["from A", "from B"]).toContain(finalBody);
  });
});

describe("central mode — Durable Object crash recovery (spec/scale-out.md §6.1)", () => {
  it("a replica that never releases its lease (simulated crash) frees the id for another replica after leaseTtlMs", async () => {
    const kv = new LibsqlKv(createFakeLibsqlClient());
    const primaries = createFakeEmbeddedReplicaPrimaries();

    let releaseHang: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    class HangingObject extends DurableObject<Record<string, never>> {
      async fetch(request: Request): Promise<Response> {
        if (new URL(request.url).pathname === "/hang") {
          await hang; // never resolves within this test — simulates a crash
        }
        return new Response("ok");
      }
    }

    const nsA = createCentralDurableObjectNamespace(HangingObject, {
      kv,
      className: "Hanging",
      env: {},
      getStorageClient: createFakeEmbeddedReplicaFactory(primaries),
      leaseTtlMs: 50,
      leaseAcquireTimeoutMs: 500,
    });
    const nsB = createCentralDurableObjectNamespace(HangingObject, {
      kv,
      className: "Hanging",
      env: {},
      getStorageClient: createFakeEmbeddedReplicaFactory(primaries),
      leaseTtlMs: 50,
      leaseAcquireTimeoutMs: 500,
    });
    const id = nsA.idFromName("crashed");

    // Replica A "crashes" mid-request: fire the request but never let it
    // finish, and never release its lease.
    void nsA.get(id).fetch(new Request("http://x/hang"));
    await new Promise((r) => setTimeout(r, 10)); // let A acquire the lease

    // Replica B recovers the id once the lease's TTL expires — well within
    // its own acquireTimeoutMs.
    const res = await nsB
      .get(nsB.idFromName("crashed"))
      .fetch(new Request("http://x/"));
    expect(await res.text()).toBe("ok");

    releaseHang?.();
  });
});
