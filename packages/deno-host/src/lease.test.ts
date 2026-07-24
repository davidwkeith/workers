import { describe, it, expect } from "vitest";
import { acquireLease, releaseLease, LeaseContendedError } from "./lease.js";
import { FakeDenoKv } from "./test-harness.js";

describe("acquireLease/releaseLease (host-contract §3.3 rule 1)", () => {
  it("acquires an unheld lease and releases it", async () => {
    const kv = new FakeDenoKv();
    const key = ["dwk_lease", "Pod", "abc"];
    const lease = await acquireLease(kv, key);
    expect((await kv.get(key)).versionstamp).not.toBeNull();
    await releaseLease(kv, lease);
    expect((await kv.get(key)).versionstamp).toBeNull();
  });

  it("throws LeaseContendedError when the lease is held past the acquire timeout", async () => {
    const kv = new FakeDenoKv();
    const key = ["dwk_lease", "Pod", "abc"];
    await acquireLease(kv, key, { ttlMs: 10_000 });
    await expect(
      acquireLease(kv, key, { acquireTimeoutMs: 120 }),
    ).rejects.toThrow(LeaseContendedError);
  });

  it("a second acquire succeeds once the first is released", async () => {
    const kv = new FakeDenoKv();
    const key = ["dwk_lease", "Pod", "abc"];
    const first = await acquireLease(kv, key);
    const secondPromise = acquireLease(kv, key, { acquireTimeoutMs: 2000 });
    await releaseLease(kv, first);
    const second = await secondPromise;
    expect(second.versionstamp).toBeDefined();
  });

  it("release is a no-op once the lease expired and a new holder acquired it", async () => {
    const kv = new FakeDenoKv();
    const key = ["dwk_lease", "Pod", "abc"];
    const first = await acquireLease(kv, key, { ttlMs: 20 });
    await new Promise((r) => setTimeout(r, 40)); // let it expire
    const second = await acquireLease(kv, key);
    await releaseLease(kv, first); // stale — must not delete `second`'s lease
    expect((await kv.get(key)).versionstamp).toBe(second.versionstamp);
  });
});
