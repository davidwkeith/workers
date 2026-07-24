/**
 * Phase 2 multi-replica integration: two `DwkServer` instances in one vitest
 * process sharing one libSQL backing (a `node:sqlite`-driven `LibsqlClientLike`
 * fake, as in `libsql-kv.test.ts`) and one in-memory S3 fake, proving the
 * `central` storage mode's decisive claim — replicas are interchangeable and
 * a write on one is visible from the other through the shared primary — for
 * the stateless/D1 paths this phase covers (Durable Objects are phase 3).
 *
 * @see spec/scale-out.md §14 item 2 (issue #431)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

import { createWebfinger } from "@dwk/webfinger";
import { createHostMeta } from "@dwk/host-meta";
import { createIndieAuthStore } from "@dwk/indieauth";

import { createCentralServer, type DwkServer } from "./server.js";
import { assembleCentralBindings } from "./central-bindings.js";
import { assertModeMarker, probeCentralStores } from "./central-mode.js";
import { LibsqlKv } from "./libsql-kv.js";
import {
  createFakeLibsqlClient,
  FakeS3Client,
} from "./central-test-harness.js";
import type { FetchHandler, Mount } from "./config.js";

const ORIGIN = "http://localhost";

interface Replica {
  server: DwkServer;
  base: string;
  env: Record<string, unknown>;
}

let dataDir = "";
let replicaA: Replica;
let replicaB: Replica;
let coordinationKv: LibsqlKv;

function mounts(): Mount[] {
  return [
    {
      name: "@dwk/webfinger",
      handler: createWebfinger({
        resources: {
          "acct:alice@localhost": {
            subject: "acct:alice@localhost",
            links: [
              {
                rel: "http://webfinger.net/rel/profile-page",
                href: `${ORIGIN}/alice`,
              },
            ],
          },
        },
      }) as unknown as FetchHandler,
      reservedPaths: ["/.well-known/webfinger"],
    },
    {
      name: "@dwk/host-meta",
      handler: createHostMeta({
        webfingerUrl: `${ORIGIN}/.well-known/webfinger`,
      }) as unknown as FetchHandler,
      reservedPaths: ["/.well-known/host-meta"],
    },
  ];
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "dwk-central-"));

  // One shared node:sqlite connection plays the role of the single libSQL
  // primary every replica's own `LibsqlClientLike` connects to — standing in
  // for "N replicas, one primary" without a real network hop. Each replica
  // gets its own client instance (as it would over a real hrana connection),
  // all wrapping the same underlying connection.
  const primary = createFakeLibsqlClient().db;
  const objectStore = new FakeS3Client();
  coordinationKv = new LibsqlKv(createFakeLibsqlClient(primary));

  async function buildReplica(): Promise<Replica> {
    const env = assembleCentralBindings({
      d1: { AUTH_DB: createFakeLibsqlClient(primary) },
      r2: {
        MEDIA: {
          client: objectStore,
          endpoint: "https://s3.example.com/media",
        },
      },
    });
    // `createCentralServer` (not `createServer`) runs the §9.2/§9.3 mode
    // marker + startup probes before serving — once per replica, exactly as
    // each would in a real fleet — including the object-store probe it
    // builds from `storage.objectStore` itself.
    const server = await createCentralServer(
      {
        baseUrl: ORIGIN,
        dataDir,
        mounts: mounts(),
        env,
        storage: {
          mode: "central",
          kv: coordinationKv,
          objectStore: {
            client: objectStore,
            endpoint: "https://s3.example.com/media",
          },
        },
      },
      { d1: { AUTH_DB: env.AUTH_DB as D1Database } },
    );
    const { port } = await server.listen(0, "127.0.0.1");
    return { server, base: `http://127.0.0.1:${port}`, env };
  }

  // Both replicas point at the *same* dataDir — the decisive proof that
  // central mode never acquires the writer lockfile (a second `createServer`
  // against a locked dataDir in local mode throws `DataDirectoryLockedError`).
  replicaA = await buildReplica();
  replicaB = await buildReplica();
});

afterAll(async () => {
  await replicaA?.server.close();
  await replicaB?.server.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("central mode — two replicas sharing one primary", () => {
  it("serves identical stateless discovery documents from both replicas", async () => {
    for (const replica of [replicaA, replicaB]) {
      const res = await fetch(
        `${replica.base}/.well-known/webfinger?resource=acct:alice@localhost`,
      );
      expect(res.status).toBe(200);
      const jrd = (await res.json()) as { subject: string };
      expect(jrd.subject).toBe("acct:alice@localhost");

      const hostMeta = await fetch(`${replica.base}/.well-known/host-meta`);
      expect(hostMeta.status).toBe(200);
      expect(await hostMeta.text()).toContain("webfinger");
    }
  });

  it("read-your-writes: a D1 write on replica A is visible from replica B", async () => {
    await createIndieAuthStore(replicaA.env as never).init();
    await createIndieAuthStore(replicaA.env as never).recordToken({
      jti: "shared-jti",
      clientId: "https://app.example.org/",
      me: "https://alice.example.com/",
      scope: "create",
      jkt: "thumbprint",
      issuedAt: 0,
      expiresAt: 4_000_000_000,
    });

    const activeOnB = await createIndieAuthStore(
      replicaB.env as never,
    ).isTokenActive("shared-jti", 1);
    expect(activeOnB).toBe(true);
  });

  it("streams an R2 body written on replica A back out through replica B", async () => {
    const bucket = replicaA.env.MEDIA as R2Bucket;
    await bucket.put("hello.txt", "hello from replica A");

    const readBack = await (replicaB.env.MEDIA as R2Bucket).get("hello.txt");
    expect(await readBack?.text()).toBe("hello from replica A");
  });

  it("the coordination KV's mode marker is consistent across both replicas' startups", async () => {
    // Each replica validated/wrote the same marker during its own startup
    // (via createCentralServer); re-asserting from the test's own handle
    // proves both observed the *same* marker through the shared primary, not
    // two independent local ones.
    await expect(assertModeMarker(coordinationKv)).resolves.toBeUndefined();
    const marker = await coordinationKv.get<string>(["dwk_meta", "mode"]);
    expect(marker.value).toBe("central");
  });

  it("both replicas' bindings pass the startup probe against the shared stores", async () => {
    for (const replica of [replicaA, replicaB]) {
      await expect(
        probeCentralStores({
          kv: coordinationKv,
          d1: { AUTH_DB: replica.env.AUTH_DB as D1Database },
          objectStore: replica.env.MEDIA as R2Bucket,
        }),
      ).resolves.toBeUndefined();
    }
  });
});
