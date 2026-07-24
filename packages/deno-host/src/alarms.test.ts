import { describe, it, expect } from "vitest";
import {
  setAlarm,
  getAlarm,
  deleteAlarm,
  scheduleRetry,
  listDueAlarms,
  claimDueAlarm,
  clearClaimedAlarm,
} from "./alarms.js";
import { FakeDenoKv } from "./test-harness.js";

describe("KV-indexed alarm schedule (host-contract §3.3 rule 2)", () => {
  it("getAlarm is null before any alarm is set", async () => {
    const kv = new FakeDenoKv();
    expect(await getAlarm(kv, "Pod", "abc")).toBeNull();
  });

  it("setAlarm then getAlarm round-trips the scheduled time", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "abc", 1000);
    expect(await getAlarm(kv, "Pod", "abc")).toBe(1000);
  });

  it("setAlarm replaces the previous due-index entry (single slot) and resets retryCount", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "abc", 1000);
    await setAlarm(kv, "Pod", "abc", 2000);
    expect(await getAlarm(kv, "Pod", "abc")).toBe(2000);
    const due = await listDueAlarms(kv, "Pod", 2000, 10);
    expect(due).toEqual([
      {
        key: ["dwk_alarm_due", "Pod", 2000, "abc"],
        versionstamp: expect.any(String),
        idHex: "abc",
        epochMs: 2000,
        retryCount: 0,
      },
    ]);
  });

  it("deleteAlarm clears both index entries", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "abc", 1000);
    await deleteAlarm(kv, "Pod", "abc");
    expect(await getAlarm(kv, "Pod", "abc")).toBeNull();
    expect(await listDueAlarms(kv, "Pod", 1000, 10)).toEqual([]);
  });

  it("deleteAlarm on an id with no alarm is a no-op", async () => {
    const kv = new FakeDenoKv();
    await expect(deleteAlarm(kv, "Pod", "abc")).resolves.toBeUndefined();
  });

  it("listDueAlarms returns entries at or before `now`, ordered by time, excludes later ones", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "b", 2000);
    await setAlarm(kv, "Pod", "a", 1000);
    await setAlarm(kv, "Pod", "c", 3000);
    const due = await listDueAlarms(kv, "Pod", 2000, 10);
    expect(due.map((e) => e.idHex)).toEqual(["a", "b"]);
  });

  it("listDueAlarms respects the batch limit", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "a", 1000);
    await setAlarm(kv, "Pod", "b", 1000);
    const due = await listDueAlarms(kv, "Pod", 1000, 1);
    expect(due).toHaveLength(1);
  });

  it("claimDueAlarm deletes the entry once, and fails a second concurrent claim", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "abc", 1000);
    const [entry] = await listDueAlarms(kv, "Pod", 1000, 10);
    const firstClaim = await claimDueAlarm(kv, entry!);
    expect(firstClaim).toBe(true);
    const secondClaim = await claimDueAlarm(kv, entry!);
    expect(secondClaim).toBe(false);
    expect(await listDueAlarms(kv, "Pod", 1000, 10)).toEqual([]);
  });

  it("scheduleRetry preserves a custom retryCount", async () => {
    const kv = new FakeDenoKv();
    await scheduleRetry(kv, "Pod", "abc", 3000, 2);
    expect(await getAlarm(kv, "Pod", "abc")).toBe(3000);
    const [entry] = await listDueAlarms(kv, "Pod", 3000, 10);
    expect(entry?.retryCount).toBe(2);
  });

  it("clearClaimedAlarm clears the by-id record when it still matches the claim", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "abc", 1000);
    const cleared = await clearClaimedAlarm(kv, "Pod", "abc", 1000, 0);
    expect(cleared).toBe(true);
    expect(await getAlarm(kv, "Pod", "abc")).toBeNull();
  });

  it("clearClaimedAlarm is a no-op and returns false when the record was superseded (different epochMs)", async () => {
    const kv = new FakeDenoKv();
    await setAlarm(kv, "Pod", "abc", 1000);
    await setAlarm(kv, "Pod", "abc", 5000); // a concurrent legitimate reschedule
    const cleared = await clearClaimedAlarm(kv, "Pod", "abc", 1000, 0);
    expect(cleared).toBe(false);
    expect(await getAlarm(kv, "Pod", "abc")).toBe(5000); // untouched
  });

  it("clearClaimedAlarm is a no-op and returns false when the record was superseded (different retryCount)", async () => {
    const kv = new FakeDenoKv();
    await scheduleRetry(kv, "Pod", "abc", 1000, 0);
    await scheduleRetry(kv, "Pod", "abc", 1000, 1); // same time, different retry attempt
    const cleared = await clearClaimedAlarm(kv, "Pod", "abc", 1000, 0);
    expect(cleared).toBe(false);
    expect(await getAlarm(kv, "Pod", "abc")).toBe(1000);
  });

  it("clearClaimedAlarm returns false when there is no alarm at all", async () => {
    const kv = new FakeDenoKv();
    const cleared = await clearClaimedAlarm(kv, "Pod", "abc", 1000, 0);
    expect(cleared).toBe(false);
  });
});
