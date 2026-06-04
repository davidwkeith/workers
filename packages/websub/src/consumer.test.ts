import { describe, it, expect, vi } from "vitest";
import { createWebSubQueueConsumer } from "./consumer";
import type { WebSubEnv } from "./config";
import type { WebSubJob } from "./queue";
import type {
  Subscription,
  SubscriptionStore,
  SubscriptionUpsert,
} from "./store";
import type { FetchLike } from "./fetch";
import type {
  ExecutionContext,
  Message,
  MessageBatch,
} from "@cloudflare/workers-types";

const config = {
  baseUrl: "https://hub.example",
  allowedTopics: ["https://example.com/feed"],
};
const ctx = {} as ExecutionContext;

class MemoryStore implements SubscriptionStore {
  readonly rows = new Map<string, Subscription>();
  pruned = 0;
  private key(c: string, t: string) {
    return `${c}\n${t}`;
  }
  async upsert(s: SubscriptionUpsert) {
    this.rows.set(this.key(s.callback, s.topic), {
      callback: s.callback,
      topic: s.topic,
      secret: s.secret ?? null,
      leaseSeconds: s.leaseSeconds,
      expiresAt: s.now + s.leaseSeconds * 1000,
      createdAt: s.now,
    });
  }
  async remove(callback: string, topic: string) {
    this.rows.delete(this.key(callback, topic));
  }
  async listActive(topic: string, now: number) {
    return [...this.rows.values()].filter(
      (s) => s.topic === topic && s.expiresAt > now,
    );
  }
  async get(callback: string, topic: string) {
    return this.rows.get(this.key(callback, topic)) ?? null;
  }
  async pruneExpired(now: number) {
    let removed = 0;
    for (const [k, s] of this.rows) {
      if (s.expiresAt <= now) {
        this.rows.delete(k);
        removed++;
      }
    }
    this.pruned += removed;
    return removed;
  }
}

function batchOf(jobs: WebSubJob[]): {
  batch: MessageBatch<WebSubJob>;
  acks: number[];
  retries: number[];
} {
  const acks: number[] = [];
  const retries: number[] = [];
  const messages = jobs.map(
    (body, i) =>
      ({
        body,
        ack: () => acks.push(i),
        retry: () => retries.push(i),
      }) as unknown as Message<WebSubJob>,
  );
  return {
    batch: { messages } as unknown as MessageBatch<WebSubJob>,
    acks,
    retries,
  };
}

describe("createWebSubQueueConsumer — verify jobs", () => {
  it("activates a subscription when intent is confirmed", async () => {
    const store = new MemoryStore();
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      const challenge = new URL(input).searchParams.get("hub.challenge");
      return new Response(challenge, { status: 200 });
    });
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store, now: () => 1000 },
    );
    const { batch, acks } = batchOf([
      {
        kind: "verify",
        mode: "subscribe",
        callback: "https://sub.example/cb",
        topic: "https://example.com/feed",
        leaseSeconds: 600,
        secret: "sek",
      },
    ]);
    await consumer(batch, {} as WebSubEnv, ctx);

    const got = await store.get(
      "https://sub.example/cb",
      "https://example.com/feed",
    );
    expect(got?.secret).toBe("sek");
    expect(got?.expiresAt).toBe(1000 + 600 * 1000);
    expect(acks).toEqual([0]);
  });

  it("does not store when intent is not confirmed", async () => {
    const store = new MemoryStore();
    const fetchImpl: FetchLike = vi.fn(
      async () => new Response("nope", { status: 200 }),
    );
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store },
    );
    const { batch, acks } = batchOf([
      {
        kind: "verify",
        mode: "subscribe",
        callback: "https://sub.example/cb",
        topic: "https://example.com/feed",
        leaseSeconds: 600,
      },
    ]);
    await consumer(batch, {} as WebSubEnv, ctx);
    expect(store.rows.size).toBe(0);
    expect(acks).toEqual([0]);
  });

  it("removes a subscription on a confirmed unsubscribe", async () => {
    const store = new MemoryStore();
    await store.upsert({
      callback: "https://sub.example/cb",
      topic: "https://example.com/feed",
      leaseSeconds: 600,
      now: 0,
    });
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      const challenge = new URL(input).searchParams.get("hub.challenge");
      return new Response(challenge, { status: 200 });
    });
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store },
    );
    const { batch, acks } = batchOf([
      {
        kind: "verify",
        mode: "unsubscribe",
        callback: "https://sub.example/cb",
        topic: "https://example.com/feed",
        leaseSeconds: 0,
      },
    ]);
    await consumer(batch, {} as WebSubEnv, ctx);
    expect(store.rows.size).toBe(0);
    expect(acks).toEqual([0]);
  });

  it("retries when the store write throws", async () => {
    const failing: SubscriptionStore = {
      upsert: () => Promise.reject(new Error("db down")),
      remove: () => Promise.resolve(),
      listActive: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      pruneExpired: () => Promise.resolve(0),
    };
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      const challenge = new URL(input).searchParams.get("hub.challenge");
      return new Response(challenge, { status: 200 });
    });
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store: failing },
    );
    const { batch, acks, retries } = batchOf([
      {
        kind: "verify",
        mode: "subscribe",
        callback: "https://sub.example/cb",
        topic: "https://example.com/feed",
        leaseSeconds: 600,
      },
    ]);
    await consumer(batch, {} as WebSubEnv, ctx);
    expect(acks).toEqual([]);
    expect(retries).toEqual([0]);
  });
});

describe("createWebSubQueueConsumer — distribute jobs", () => {
  it("fetches the topic and fans out to active subscribers", async () => {
    const store = new MemoryStore();
    await store.upsert({
      callback: "https://sub.example/cb",
      topic: "https://example.com/feed",
      secret: "sek",
      leaseSeconds: 1000,
      now: 0,
    });
    const posted: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response("<feed>new</feed>", {
          status: 200,
          headers: { "content-type": "application/atom+xml" },
        });
      }
      posted.push(input);
      return new Response(null, { status: 204 });
    });
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store, now: () => 500 },
    );
    const { batch, acks } = batchOf([
      { kind: "distribute", topic: "https://example.com/feed" },
    ]);
    await consumer(batch, {} as WebSubEnv, ctx);
    expect(posted).toEqual(["https://sub.example/cb"]);
    expect(acks).toEqual([0]);
  });

  it("prunes expired leases and skips them in fan-out", async () => {
    const store = new MemoryStore();
    await store.upsert({
      callback: "https://dead.example/cb",
      topic: "https://example.com/feed",
      leaseSeconds: 10,
      now: 0,
    });
    await store.upsert({
      callback: "https://live.example/cb",
      topic: "https://example.com/feed",
      leaseSeconds: 100000,
      now: 0,
    });
    const posted: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response("x", { status: 200 });
      }
      posted.push(input);
      return new Response(null, { status: 200 });
    });
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store, now: () => 60_000 },
    );
    const { batch } = batchOf([
      { kind: "distribute", topic: "https://example.com/feed" },
    ]);
    await consumer(batch, {} as WebSubEnv, ctx);
    expect(store.pruned).toBe(1);
    expect(posted).toEqual(["https://live.example/cb"]);
  });

  it("retries the distribute job when the topic is unreachable", async () => {
    const store = new MemoryStore();
    const fetchImpl: FetchLike = vi.fn(
      async () => new Response("", { status: 503 }),
    );
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store },
    );
    const { batch, acks, retries } = batchOf([
      { kind: "distribute", topic: "https://example.com/feed" },
    ]);
    await consumer(batch, {} as WebSubEnv, ctx);
    expect(acks).toEqual([]);
    expect(retries).toEqual([0]);
  });

  it("fails loudly when no store is configured", async () => {
    const consumer = createWebSubQueueConsumer(config);
    const { batch } = batchOf([
      { kind: "distribute", topic: "https://example.com/feed" },
    ]);
    await expect(consumer(batch, {} as WebSubEnv, ctx)).rejects.toThrow(
      /WEBSUB_DB/,
    );
  });
});
