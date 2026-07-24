import { describe, it, expect, beforeEach } from "vitest";
import {
  createDurableObjectNamespace,
  DurableObject,
  type AlarmInvocationInfo,
} from "./durable-object.js";
import { setAlarm, getAlarm } from "./alarms.js";
import { acquireLease, releaseLease } from "./lease.js";
import { FakeDenoKv, createStrictSyncSqlite } from "./test-harness.js";

describe("pollAlarms (host-contract §3.3 rule 2)", () => {
  let fireLog: Array<{ id: string; retryCount: number }>;
  let failOnce: Set<string>;

  beforeEach(() => {
    fireLog = [];
    failOnce = new Set();
  });

  class AlarmObject extends DurableObject<Record<string, never>> {
    async fetch(): Promise<Response> {
      return new Response("ok");
    }
    override async alarm(info?: AlarmInvocationInfo): Promise<void> {
      const idHex = this.ctx.id.toString();
      fireLog.push({ id: idHex, retryCount: info?.retryCount ?? 0 });
      if (failOnce.delete(idHex)) throw new Error("boom");
    }
  }

  function makeNs(kv: FakeDenoKv, db = createStrictSyncSqlite()) {
    return createDurableObjectNamespace(AlarmObject, {
      kv,
      className: "AlarmObject",
      env: {},
      getStorageClient: () => db,
    });
  }

  it("fires a due alarm once, clearing its due-index entry", async () => {
    const kv = new FakeDenoKv();
    const ns = makeNs(kv);
    const id = ns.idFromName("alice");
    await setAlarm(kv, "AlarmObject", id.toString(), 1000);
    await ns.pollAlarms({ now: 1000 });
    expect(fireLog).toEqual([{ id: id.toString(), retryCount: 0 }]);
    await ns.pollAlarms({ now: 1000 });
    expect(fireLog).toHaveLength(1);
  });

  it("does not fire an alarm scheduled in the future", async () => {
    const kv = new FakeDenoKv();
    const ns = makeNs(kv);
    const id = ns.idFromName("alice");
    await setAlarm(kv, "AlarmObject", id.toString(), 5000);
    await ns.pollAlarms({ now: 1000 });
    expect(fireLog).toEqual([]);
    await ns.pollAlarms({ now: 5000 });
    expect(fireLog).toEqual([{ id: id.toString(), retryCount: 0 }]);
  });

  it("retries a throwing handler by scheduling a new due entry, then fires again with an incremented retryCount", async () => {
    const kv = new FakeDenoKv();
    const ns = makeNs(kv);
    const id = ns.idFromName("alice");
    const idHex = id.toString();
    failOnce.add(idHex);
    await setAlarm(kv, "AlarmObject", idHex, 1000);
    await ns.pollAlarms({ now: 1000 });
    expect(fireLog).toEqual([{ id: idHex, retryCount: 0 }]);
    const retryAt = await getAlarm(kv, "AlarmObject", idHex);
    expect(retryAt).toBe(1000 + 2000); // base backoff for retryCount 0
    await ns.pollAlarms({ now: retryAt! });
    expect(fireLog).toEqual([
      { id: idHex, retryCount: 0 },
      { id: idHex, retryCount: 1 },
    ]);
  });

  it("a handler that sets a new alarm during its run supersedes the auto-retry", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    class SupersedeObject extends DurableObject<Record<string, never>> {
      async fetch(): Promise<Response> {
        return new Response("ok");
      }
      override async alarm(): Promise<void> {
        await this.ctx.storage.setAlarm(9999);
        throw new Error("boom");
      }
    }
    const ns = createDurableObjectNamespace(SupersedeObject, {
      kv,
      className: "Supersede",
      env: {},
      getStorageClient: () => db,
    });
    const id = ns.idFromName("alice");
    await setAlarm(kv, "Supersede", id.toString(), 1000);
    await ns.pollAlarms({ now: 1000 });
    expect(await getAlarm(kv, "Supersede", id.toString())).toBe(9999);
  });

  it("two namespaces sharing one KV only fire a due alarm once", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    const ns1 = makeNs(kv, db);
    const ns2 = makeNs(kv, db);
    const id = ns1.idFromName("alice");
    await setAlarm(kv, "AlarmObject", id.toString(), 1000);
    await Promise.all([
      ns1.pollAlarms({ now: 1000 }),
      ns2.pollAlarms({ now: 1000 }),
    ]);
    expect(fireLog).toHaveLength(1);
  });

  it("does not drop an alarm when the lease is contended during firing — reschedules immediately without consuming a retry", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    const ns = createDurableObjectNamespace(AlarmObject, {
      kv,
      className: "AlarmObject",
      env: {},
      getStorageClient: () => db,
      leaseAcquireTimeoutMs: 100,
    });
    const id = ns.idFromName("alice");
    const idHex = id.toString();
    await setAlarm(kv, "AlarmObject", idHex, 1000);

    // Simulate another process holding this id's lease during the fire attempt.
    const contendingLease = await acquireLease(
      kv,
      ["dwk_lease", "AlarmObject", idHex],
      { ttlMs: 10_000 },
    );

    await ns.pollAlarms({ now: 1000 });
    expect(fireLog).toEqual([]); // handler never ran — lease was held elsewhere
    expect(await getAlarm(kv, "AlarmObject", idHex)).toBe(1000); // NOT lost

    await releaseLease(kv, contendingLease);
    await ns.pollAlarms({ now: 1000 });
    expect(fireLog).toEqual([{ id: idHex, retryCount: 0 }]); // now fires normally
  });

  it("calls onLeaseAcquired before an alarm handler runs, but not for a superseded/no-op claim", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    const synced: string[] = [];
    const ns = createDurableObjectNamespace(AlarmObject, {
      kv,
      className: "AlarmObject",
      env: {},
      getStorageClient: () => db,
      onLeaseAcquired: (idHex) => {
        synced.push(idHex);
      },
    });
    const id = ns.idFromName("alice");
    const idHex = id.toString();
    await setAlarm(kv, "AlarmObject", idHex, 1000);
    await ns.pollAlarms({ now: 1000 });
    expect(fireLog).toEqual([{ id: idHex, retryCount: 0 }]);
    expect(synced).toEqual([idHex]);

    // A poll that finds nothing due never fires the handler, so the sync hook
    // (which costs a network round trip in a real host) is not called either.
    await ns.pollAlarms({ now: 1000 });
    expect(synced).toEqual([idHex]);
  });

  it("does not delete a concurrently-rescheduled future alarm when a stale fire attempt finally acquires the lease", async () => {
    const kv = new FakeDenoKv();
    const db = createStrictSyncSqlite();
    const ns = createDurableObjectNamespace(AlarmObject, {
      kv,
      className: "AlarmObject",
      env: {},
      getStorageClient: () => db,
      leaseAcquireTimeoutMs: 2000,
    });
    const id = ns.idFromName("alice");
    const idHex = id.toString();
    await setAlarm(kv, "AlarmObject", idHex, 1000);

    // Simulate a concurrent fetch() holding the id's lease.
    const holderLease = await acquireLease(
      kv,
      ["dwk_lease", "AlarmObject", idHex],
      { ttlMs: 10_000 },
    );
    const pollPromise = ns.pollAlarms({ now: 1000 });
    await new Promise((r) => setTimeout(r, 10)); // let pollAlarms block in acquireLease
    // The concurrent fetch()'s handler legitimately reschedules the alarm
    // before releasing the lease.
    await setAlarm(kv, "AlarmObject", idHex, 5000);
    await releaseLease(kv, holderLease);
    await pollPromise;

    // The stale fire attempt (claimed the old epochMs=1000 entry) must not
    // fire the handler or delete the fresh reschedule out from under it.
    expect(fireLog).toEqual([]);
    expect(await getAlarm(kv, "AlarmObject", idHex)).toBe(5000);

    // The fresh schedule still fires normally once it's actually due.
    await ns.pollAlarms({ now: 5000 });
    expect(fireLog).toEqual([{ id: idHex, retryCount: 0 }]);
  });
});
