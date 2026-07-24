import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DurableObject,
  createQueueBroker,
  type AlarmInvocationInfo,
} from "@dwk/deno-host";
import { setAlarm } from "@dwk/deno-host";
import { createCentralDurableObjectNamespace } from "./central-durable-object.js";
import { CentralFleetPoller } from "./central-fleet-poller.js";
import { LibsqlKv } from "./libsql-kv.js";
import {
  createFakeEmbeddedReplicaFactory,
  createFakeEmbeddedReplicaPrimaries,
  createFakeLibsqlClient,
} from "./central-test-harness.js";

function fakeKv(): LibsqlKv {
  return new LibsqlKv(createFakeLibsqlClient());
}

class AlarmObject extends DurableObject<Record<string, never>> {
  async fetch(): Promise<Response> {
    return new Response("ok");
  }
  override async alarm(_info?: AlarmInvocationInfo): Promise<void> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fired (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL DEFAULT 0)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO fired (id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = n + 1",
    );
  }
}

const poll = new Set<CentralFleetPoller>();
afterEach(async () => {
  for (const p of poll) await p.stop();
  poll.clear();
});

describe("CentralFleetPoller", () => {
  it("fireAll() polls every registered namespace and sweeps the coordination KV", async () => {
    const kv = fakeKv();
    const primaries = createFakeEmbeddedReplicaPrimaries();
    const ns = createCentralDurableObjectNamespace(AlarmObject, {
      kv,
      className: "AlarmObject",
      env: {},
      getStorageClient: createFakeEmbeddedReplicaFactory(primaries),
    });
    const id = ns.idFromName("alice");
    await setAlarm(kv, "AlarmObject", id.toString(), 0);

    const sweepSpy = vi.spyOn(kv, "sweepExpired");
    const poller = new CentralFleetPoller({
      namespaces: [ns],
      kv,
      now: () => 1000,
    });
    poll.add(poller);
    await poller.fireAll();

    const primary = primaries.get(id.toString());
    expect(primary?.prepare("SELECT n FROM fired WHERE id = 1").get()).toEqual({
      n: 1,
    });
    expect(sweepSpy).toHaveBeenCalledWith(1000);
  });

  it("a due alarm fires exactly once even though two replicas' pollers both tick for it", async () => {
    const kv = fakeKv();
    const primaries = createFakeEmbeddedReplicaPrimaries();
    const nsA = createCentralDurableObjectNamespace(AlarmObject, {
      kv,
      className: "AlarmObject",
      env: {},
      getStorageClient: createFakeEmbeddedReplicaFactory(primaries),
    });
    const nsB = createCentralDurableObjectNamespace(AlarmObject, {
      kv,
      className: "AlarmObject",
      env: {},
      getStorageClient: createFakeEmbeddedReplicaFactory(primaries),
    });
    const id = nsA.idFromName("alice");
    await setAlarm(kv, "AlarmObject", id.toString(), 0);

    const pollerA = new CentralFleetPoller({
      namespaces: [nsA],
      now: () => 1000,
    });
    const pollerB = new CentralFleetPoller({
      namespaces: [nsB],
      now: () => 1000,
    });
    poll.add(pollerA);
    poll.add(pollerB);
    await Promise.all([pollerA.fireAll(), pollerB.fireAll()]);

    const primary = primaries.get(id.toString());
    expect(primary?.prepare("SELECT n FROM fired WHERE id = 1").get()).toEqual({
      n: 1,
    });
  });

  it("suppresses overlapping ticks and logs (rather than throws) a namespace poll failure", async () => {
    const warnings: string[] = [];
    const failing = {
      pollAlarms: vi.fn().mockRejectedValue(new Error("kv unreachable")),
    };
    const poller = new CentralFleetPoller({
      namespaces: [failing],
      logger: {
        debug: () => {},
        info: () => {},
        warn: (event) => warnings.push(event),
        error: () => {},
      },
    });
    poll.add(poller);
    await poller.fireAll();
    expect(warnings).toEqual(["central_fleet.alarm_poll_error"]);
  });

  it("start()/stop() ticks on an interval and can be stopped cleanly", async () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      const ns = { pollAlarms: async () => void calls.push(Date.now()) };
      const poller = new CentralFleetPoller({
        namespaces: [ns],
        intervalMs: 100,
        jitterMs: 0,
      });
      poller.start();
      await vi.advanceTimersByTimeAsync(350);
      expect(calls.length).toBeGreaterThanOrEqual(3);
      await poller.stop();
      const countAtStop = calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(calls.length).toBe(countAtStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fireAll() polls every registered queue broker (spec §7.1, #433)", async () => {
    const kv = fakeKv();
    const broker = createQueueBroker(kv, { now: () => 1000 });
    const delivered: unknown[] = [];
    broker.consumer("WORK", async (batch) => {
      for (const message of batch.messages) {
        delivered.push(message.body);
        message.ack();
      }
    });
    await broker.producer("WORK").send({ job: 1 });

    const poller = new CentralFleetPoller({
      queues: [broker],
      now: () => 1000,
    });
    poll.add(poller);
    await poller.fireAll();

    expect(delivered).toEqual([{ job: 1 }]);
  });

  it("a queued message delivers exactly once even though two replicas' pollers both tick for it", async () => {
    const kv = fakeKv();
    const brokerA = createQueueBroker(kv, { now: () => 1000 });
    const brokerB = createQueueBroker(kv, { now: () => 1000 });
    const deliveredA: unknown[] = [];
    const deliveredB: unknown[] = [];
    brokerA.consumer("WORK", async (batch) => {
      for (const m of batch.messages) {
        deliveredA.push(m.body);
        m.ack();
      }
    });
    brokerB.consumer("WORK", async (batch) => {
      for (const m of batch.messages) {
        deliveredB.push(m.body);
        m.ack();
      }
    });
    await brokerA.producer("WORK").send({ job: 1 });

    const pollerA = new CentralFleetPoller({
      queues: [brokerA],
      now: () => 1000,
    });
    const pollerB = new CentralFleetPoller({
      queues: [brokerB],
      now: () => 1000,
    });
    poll.add(pollerA);
    poll.add(pollerB);
    await Promise.all([pollerA.fireAll(), pollerB.fireAll()]);

    expect(deliveredA.length + deliveredB.length).toBe(1);
  });

  it("logs (rather than throws) a queue broker poll failure", async () => {
    const warnings: string[] = [];
    const failing = {
      pollQueues: vi.fn().mockRejectedValue(new Error("kv down")),
    };
    const poller = new CentralFleetPoller({
      queues: [failing],
      logger: {
        debug: () => {},
        info: () => {},
        warn: (event) => warnings.push(event),
        error: () => {},
      },
    });
    poll.add(poller);
    await poller.fireAll();
    expect(warnings).toEqual(["central_fleet.queue_poll_error"]);
  });

  it("logs the sweep count when expired rows were actually removed", async () => {
    const kv = fakeKv();
    await kv.set(["dwk_meta", "probe"], true, { expireIn: -1 });
    const infos: Array<[string, Record<string, unknown>]> = [];
    const poller = new CentralFleetPoller({
      kv,
      logger: {
        debug: () => {},
        info: (event, fields) => infos.push([event, fields ?? {}]),
        warn: () => {},
        error: () => {},
      },
    });
    poll.add(poller);
    await poller.fireAll();
    expect(infos).toEqual([["central_fleet.sweep_ok", { count: 1 }]]);
  });
});
