import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createD1SubscriptionStore } from "./store";

interface TestEnv {
  WEBSUB_DB: import("@cloudflare/workers-types").D1Database;
}

const db = (env as unknown as TestEnv).WEBSUB_DB;

describe("createD1SubscriptionStore", () => {
  it("creates its table and upserts then reads a subscription", async () => {
    const store = createD1SubscriptionStore(db, { table: "ws_basic" });
    await store.upsert({
      callback: "https://sub.example/cb",
      topic: "https://example.com/feed",
      secret: "s",
      leaseSeconds: 600,
      now: 1000,
    });
    const got = await store.get(
      "https://sub.example/cb",
      "https://example.com/feed",
    );
    expect(got).toEqual({
      callback: "https://sub.example/cb",
      topic: "https://example.com/feed",
      secret: "s",
      leaseSeconds: 600,
      expiresAt: 1000 + 600 * 1000,
      createdAt: 1000,
    });
  });

  it("renews (upserts) in place on the (callback, topic) key", async () => {
    const store = createD1SubscriptionStore(db, { table: "ws_renew" });
    const base = {
      callback: "https://sub.example/cb",
      topic: "https://example.com/feed",
      leaseSeconds: 100,
    };
    await store.upsert({ ...base, now: 1000 });
    await store.upsert({ ...base, leaseSeconds: 200, now: 5000 });
    const active = await store.listActive("https://example.com/feed", 6000);
    expect(active).toHaveLength(1);
    expect(active[0]?.expiresAt).toBe(5000 + 200 * 1000);
  });

  it("stores a null secret when none is given", async () => {
    const store = createD1SubscriptionStore(db, { table: "ws_nosecret" });
    await store.upsert({
      callback: "https://sub.example/cb",
      topic: "https://example.com/feed",
      leaseSeconds: 600,
      now: 1,
    });
    const got = await store.get(
      "https://sub.example/cb",
      "https://example.com/feed",
    );
    expect(got?.secret).toBeNull();
  });

  it("listActive excludes expired leases and scopes by topic", async () => {
    const store = createD1SubscriptionStore(db, { table: "ws_active" });
    await store.upsert({
      callback: "https://a.example/cb",
      topic: "https://example.com/feed",
      leaseSeconds: 10,
      now: 0,
    });
    await store.upsert({
      callback: "https://b.example/cb",
      topic: "https://example.com/feed",
      leaseSeconds: 1000,
      now: 0,
    });
    await store.upsert({
      callback: "https://c.example/cb",
      topic: "https://example.com/other",
      leaseSeconds: 1000,
      now: 0,
    });
    // At t=20_000ms, a's 10s lease has expired; only b is active for the feed.
    const active = await store.listActive("https://example.com/feed", 20_000);
    expect(active.map((s) => s.callback)).toEqual(["https://b.example/cb"]);
  });

  it("removes a subscription", async () => {
    const store = createD1SubscriptionStore(db, { table: "ws_remove" });
    await store.upsert({
      callback: "https://sub.example/cb",
      topic: "https://example.com/feed",
      leaseSeconds: 600,
      now: 0,
    });
    await store.remove("https://sub.example/cb", "https://example.com/feed");
    expect(
      await store.get("https://sub.example/cb", "https://example.com/feed"),
    ).toBeNull();
  });

  it("pruneExpired deletes only dead leases and returns the count", async () => {
    const store = createD1SubscriptionStore(db, { table: "ws_prune" });
    await store.upsert({
      callback: "https://dead.example/cb",
      topic: "https://example.com/feed",
      leaseSeconds: 10,
      now: 0,
    });
    await store.upsert({
      callback: "https://live.example/cb",
      topic: "https://example.com/feed",
      leaseSeconds: 1000,
      now: 0,
    });
    const removed = await store.pruneExpired(20_000);
    expect(removed).toBe(1);
    const active = await store.listActive("https://example.com/feed", 20_000);
    expect(active.map((s) => s.callback)).toEqual(["https://live.example/cb"]);
  });

  it("rejects an unsafe table name", () => {
    expect(() => createD1SubscriptionStore(db, { table: "bad name;" })).toThrow(
      /invalid subscription table name/,
    );
  });
});
