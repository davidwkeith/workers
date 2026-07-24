/**
 * Phase 4 multi-replica integration (spec/scale-out.md §14, #433): the fleet
 * lifecycle pieces that only prove themselves end to end through real HTTP
 * dispatch — readiness flipping on an induced store outage, and a graceful
 * `closeCentral` drain on one replica while a peer keeps the fleet operable.
 *
 * The queue/cron *coordination* mechanics themselves (exactly-once delivery
 * across two independent pollers/schedulers sharing one coordination store,
 * redelivery when a handler never decides, single-winner tick-lease
 * election) are proven more directly at the unit level in
 * `central-fleet-poller.test.ts` and `central-cron.test.ts` — two
 * independent `CentralFleetPoller`/`CentralCronScheduler` instances sharing
 * one `LibsqlKv` back-end **are** two replicas from the coordination store's
 * point of view; wrapping them in real `DwkServer`/Express instances here
 * would not exercise any additional distributed-coordination logic.
 *
 * @see spec/scale-out.md §7, §12, §14 (issue #433)
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQueueBroker, type DenoKvLike } from "@dwk/deno-host";

import { createCentralServer, type DwkServer } from "./server.js";
import { CentralFleetPoller } from "./central-fleet-poller.js";
import { createCentralHealthMounts } from "./central-health.js";
import { LibsqlKv } from "./libsql-kv.js";
import { createFakeLibsqlClient } from "./central-test-harness.js";

const ORIGIN = "http://localhost";

const tempDirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-central-fleet-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("central mode — readiness over real HTTP (spec/scale-out.md §12)", () => {
  it("flips 200 -> 503 -> 200 as the coordination store goes down and recovers", async () => {
    let broken = false;
    const realKv = new LibsqlKv(createFakeLibsqlClient());
    // A thin delegating wrapper (not a `Proxy` — `LibsqlKv`'s private fields
    // require its methods run with `this` bound to the real instance) so the
    // test can flip the KV from "reachable" to "unreachable" without needing
    // a second real store.
    const flakyKv: DenoKvLike = {
      get: (...args) => realKv.get(...args),
      set: (...args) =>
        broken
          ? Promise.reject(new Error("kv unreachable"))
          : realKv.set(...args),
      delete: (...args) => realKv.delete(...args),
      list: (...args) => realKv.list(...args),
      atomic: (...args) => realKv.atomic(...args),
    };

    const healthMounts = createCentralHealthMounts({
      probeTargets: { kv: flakyKv },
      cacheMs: 0, // always re-probe, so the test doesn't need to fast-forward a clock
    });

    const server = await createCentralServer({
      baseUrl: ORIGIN,
      dataDir: dataDir(),
      mounts: healthMounts,
      env: {},
      storage: { mode: "central", kv: realKv },
    });
    const { port } = await server.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;

    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/readyz`)).status).toBe(200);

      broken = true;
      const failing = await fetch(`${base}/readyz`);
      expect(failing.status).toBe(503);
      // Liveness is unaffected by a store outage — that is the point of
      // having two separate endpoints (spec/scale-out.md §12).
      expect((await fetch(`${base}/healthz`)).status).toBe(200);

      broken = false;
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("central mode — closeCentral drains one replica while a peer keeps the fleet operable", () => {
  interface Replica {
    server: DwkServer;
    base: string;
  }

  it("in-flight work on the closing replica finishes, and an unacked message is still delivered via the peer", async () => {
    const primary = createFakeLibsqlClient().db;
    const coordinationKv = new LibsqlKv(createFakeLibsqlClient(primary));

    async function buildReplica(): Promise<Replica> {
      const server = await createCentralServer({
        baseUrl: ORIGIN,
        dataDir: dataDir(),
        mounts: [],
        env: {},
        storage: { mode: "central", kv: coordinationKv },
      });
      const { port } = await server.listen(0, "127.0.0.1");
      return { server, base: `http://127.0.0.1:${port}` };
    }

    const replicaA = await buildReplica();
    const replicaB = await buildReplica();

    const brokerA = createQueueBroker(coordinationKv);
    const brokerB = createQueueBroker(coordinationKv);
    const delivered: string[] = [];
    let releaseHandler: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolveStarted) => {
      // A short baseRetryDelayMs so this test doesn't need to wait out the
      // default 1s backoff for the requeued "undecided" message below.
      brokerA.consumer(
        "WORK",
        async (batch) => {
          resolveStarted();
          // Simulate slow in-flight work that closeCentral must wait out.
          await new Promise<void>((resolve) => {
            releaseHandler = resolve;
          });
          for (const m of batch.messages) {
            delivered.push(`A:${JSON.stringify(m.body)}`);
            // Deliberately do not decide on the second message — it must be
            // redelivered (host-contract §3.6) and picked up by replica B.
            if (m.body !== "undecided") m.ack();
          }
        },
        { baseRetryDelayMs: 10 },
      );
    });
    brokerB.consumer("WORK", async (batch) => {
      for (const m of batch.messages) {
        delivered.push(`B:${JSON.stringify(m.body)}`);
        m.ack();
      }
    });

    await brokerA.producer("WORK").send("decided");
    await brokerA.producer("WORK").send("undecided");

    const pollerA = new CentralFleetPoller({ queues: [brokerA] });
    const pollerB = new CentralFleetPoller({ queues: [brokerB] });
    // Drive replica A's one in-flight tick directly (rather than `start()`)
    // so it deterministically claims both due messages before replica B's
    // poller ever runs — avoiding a claim race that would make this test
    // flaky about which replica gets which message.
    const tickA = pollerA.fireAll();

    await handlerStarted;
    // closeCentral on replica A must wait for the in-flight batch (and
    // pollerA.stop()) before resolving — release the handler slightly after
    // calling it, proving close waits rather than abandoning the poll.
    const closePromise = replicaA.server.closeCentral([pollerA]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseHandler?.();
    await Promise.all([tickA, closePromise]);

    expect(delivered).toContain('A:"decided"');
    // Replica A's handler did see "undecided" once (it was in the claimed
    // batch) but never called `.ack()`/`.retry()` on it — per host-contract
    // §3.6 that message MUST be redelivered, not silently dropped.
    expect(delivered.filter((d) => d === 'A:"undecided"')).toHaveLength(1);

    // The undecided message was requeued (not lost) — replica B's poller
    // eventually picks it up once its short backoff elapses.
    for (let i = 0; i < 20 && !delivered.includes('B:"undecided"'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      await pollerB.fireAll();
    }
    expect(delivered).toContain('B:"undecided"');

    await replicaB.server.close();
  });
});
