import { describe, it, expect, vi } from "vitest";
import { createWebSubQueueConsumer } from "./consumer.js";
import type { WebSubEnv } from "./config.js";
import { decodeInlineBody, encodeInlineBody } from "./distribute.js";
import type { WebSubJob } from "./queue.js";
import type {
  Subscription,
  SubscriptionStore,
  SubscriptionUpsert,
} from "./store.js";
import type { FetchLike } from "@dwk/safe-fetch";
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

/** In-memory Queue producer capturing every enqueued job (send + sendBatch). */
class MemoryQueue {
  readonly sent: WebSubJob[] = [];
  /** Size of each `sendBatch` call, in order — lets a test assert chunking. */
  readonly batchSizes: number[] = [];
  async send(body: WebSubJob) {
    this.sent.push(body);
  }
  async sendBatch(messages: Iterable<{ body: WebSubJob }>) {
    const batch = [...messages];
    this.batchSizes.push(batch.length);
    for (const m of batch) this.sent.push(m.body);
  }
}

/** In-memory R2 bucket exposing just the `put`/`get` surface staging uses. */
class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: ArrayBuffer | ArrayBufferView) {
    const u8 = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
    this.objects.set(key, u8);
  }
  async get(key: string) {
    const v = this.objects.get(key);
    if (v === undefined) return null;
    return {
      arrayBuffer: async () =>
        v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
    };
  }
}

/** Only the deliver jobs from a captured queue, in enqueue order. */
function deliverJobs(
  queue: MemoryQueue,
): Extract<WebSubJob, { kind: "deliver" }>[] {
  return queue.sent.filter(
    (j): j is Extract<WebSubJob, { kind: "deliver" }> => j.kind === "deliver",
  );
}

/** A GET topic responder returning `body` with `application/atom+xml`, plus a POST sink. */
function distributingFetch(body: BodyInit, posted: string[]): FetchLike {
  return vi.fn(async (input, init) => {
    if ((init?.method ?? "GET") === "GET") {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/atom+xml" },
      });
    }
    posted.push(input);
    return new Response(null, { status: 204 });
  });
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

  it("does not store, and notifies denial, when intent is not confirmed", async () => {
    const store = new MemoryStore();
    const seen: { mode: string | null; topic: string | null }[] = [];
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      const url = new URL(input);
      const mode = url.searchParams.get("hub.mode");
      seen.push({ mode, topic: url.searchParams.get("hub.topic") });
      // The verification GET gets a non-echoing body, so intent is unconfirmed.
      return new Response("nope", { status: 200 });
    });
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
    // A denied subscribe sends a `hub.mode=denied` GET to the callback (§5.2).
    const denial = seen.find((s) => s.mode === "denied");
    expect(denial).toEqual({
      mode: "denied",
      topic: "https://example.com/feed",
    });
  });

  it("does not notify denial on an unconfirmed unsubscribe", async () => {
    const store = new MemoryStore();
    await store.upsert({
      callback: "https://sub.example/cb",
      topic: "https://example.com/feed",
      leaseSeconds: 600,
      now: 0,
    });
    const modes: (string | null)[] = [];
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      modes.push(new URL(input).searchParams.get("hub.mode"));
      return new Response("nope", { status: 200 });
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
    // Unconfirmed unsubscribe leaves the row and sends no denial notification.
    expect(store.rows.size).toBe(1);
    expect(modes).not.toContain("denied");
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

describe("createWebSubQueueConsumer — distribute (fan-out planner)", () => {
  const topic = "https://example.com/feed";
  const envWith = (queue: MemoryQueue, bucket?: MemoryBucket): WebSubEnv =>
    ({ WEBSUB_QUEUE: queue, WEBSUB_CONTENT: bucket }) as unknown as WebSubEnv;

  it("enqueues one inline deliver job per active subscriber", async () => {
    const store = new MemoryStore();
    await store.upsert({
      callback: "https://sub.example/cb",
      topic,
      secret: "sek",
      leaseSeconds: 1000,
      now: 0,
    });
    const queue = new MemoryQueue();
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: distributingFetch("<feed>new</feed>", []) },
      { store, now: () => 500 },
    );
    const { batch, acks } = batchOf([{ kind: "distribute", topic }]);
    await consumer(batch, envWith(queue), ctx);

    const jobs = deliverJobs(queue);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "deliver",
      callback: "https://sub.example/cb",
      topic,
      secret: "sek",
      contentType: "application/atom+xml",
      payload: { via: "inline" },
    });
    // The inline body is a base64 string (not a raw Uint8Array), so the job
    // JSON-serializes to a compact string — no `{"0":..,"1":..}` byte-map bloat.
    const payload = jobs[0]?.payload;
    expect(payload?.via === "inline" && typeof payload.body).toBe("string");
    if (payload?.via === "inline") {
      expect(new TextDecoder().decode(decodeInlineBody(payload.body))).toBe(
        "<feed>new</feed>",
      );
      // No `{"0":..,"1":..}` byte-map: the message serializes compactly, far
      // smaller than the ~10× bloat a raw Uint8Array would incur.
      const serialized = JSON.stringify(jobs[0]);
      expect(serialized).not.toContain('"0":');
      expect(serialized.length).toBeLessThan(300);
    }
    expect(acks).toEqual([0]);
  });

  it("chunks the fan-out into ≤100-message sendBatch calls for a large subscriber set", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 250; i++) {
      await store.upsert({
        callback: `https://sub${i}.example/cb`,
        topic,
        leaseSeconds: 1000,
        now: 0,
      });
    }
    const queue = new MemoryQueue();
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: distributingFetch("<feed/>", []) },
      { store, now: () => 500 },
    );
    const { batch, acks } = batchOf([{ kind: "distribute", topic }]);
    await consumer(batch, envWith(queue), ctx);

    // 250 subscribers → one deliver job each, no message enqueued more than once.
    expect(deliverJobs(queue)).toHaveLength(250);
    expect(new Set(deliverJobs(queue).map((j) => j.callback)).size).toBe(250);
    // Chunked across multiple sendBatch calls, none over the 100-message cap.
    expect(queue.batchSizes.length).toBeGreaterThan(1);
    expect(Math.max(...queue.batchSizes)).toBeLessThanOrEqual(100);
    expect(queue.batchSizes.reduce((a, b) => a + b, 0)).toBe(250);
    expect(acks).toEqual([0]);
  });

  it("retries the whole distribute job when a later sendBatch chunk fails (at-least-once)", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 150; i++) {
      await store.upsert({
        callback: `https://sub${i}.example/cb`,
        topic,
        leaseSeconds: 1000,
        now: 0,
      });
    }
    // A queue whose second sendBatch chunk throws after the first already
    // flushed: the exception propagates and the distribute job retries. Per
    // WebSub's at-least-once contract the first chunk's subscribers may then be
    // re-enqueued — a bounded, spec-tolerated duplication, not silent loss.
    class FlakyQueue extends MemoryQueue {
      calls = 0;
      override async sendBatch(messages: Iterable<{ body: WebSubJob }>) {
        this.calls++;
        if (this.calls === 2) throw new Error("queue overloaded");
        return super.sendBatch(messages);
      }
    }
    const queue = new FlakyQueue();
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: distributingFetch("<feed/>", []) },
      { store, now: () => 500 },
    );
    const { batch, acks, retries } = batchOf([{ kind: "distribute", topic }]);
    await consumer(batch, envWith(queue), ctx);
    expect(retries).toEqual([0]);
    expect(acks).toEqual([]);
  });

  it("prunes expired leases and schedules only the live subscriber", async () => {
    const store = new MemoryStore();
    await store.upsert({
      callback: "https://dead.example/cb",
      topic,
      leaseSeconds: 10,
      now: 0,
    });
    await store.upsert({
      callback: "https://live.example/cb",
      topic,
      leaseSeconds: 100000,
      now: 0,
    });
    const queue = new MemoryQueue();
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: distributingFetch("x", []) },
      { store, now: () => 60_000 },
    );
    const { batch } = batchOf([{ kind: "distribute", topic }]);
    await consumer(batch, envWith(queue), ctx);

    expect(store.pruned).toBe(1);
    expect(deliverJobs(queue).map((j) => j.callback)).toEqual([
      "https://live.example/cb",
    ]);
  });

  it("acks without scheduling when there are no active subscribers", async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueue();
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: distributingFetch("x", []) },
      { store, now: () => 500 },
    );
    const { batch, acks } = batchOf([{ kind: "distribute", topic }]);
    await consumer(batch, envWith(queue), ctx);
    expect(queue.sent).toEqual([]);
    expect(acks).toEqual([0]);
  });

  it("stages a large snapshot in R2 and references it by key", async () => {
    const store = new MemoryStore();
    await store.upsert({
      callback: "https://sub.example/cb",
      topic,
      leaseSeconds: 1000,
      now: 0,
    });
    const big = new Uint8Array(100 * 1024).fill(97); // 100 KB > inline limit
    const queue = new MemoryQueue();
    const bucket = new MemoryBucket();
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: distributingFetch(big, []) },
      { store, now: () => 500 },
    );
    const { batch, acks } = batchOf([{ kind: "distribute", topic }]);
    await consumer(batch, envWith(queue, bucket), ctx);

    const jobs = deliverJobs(queue);
    expect(jobs).toHaveLength(1);
    const payload = jobs[0]?.payload;
    expect(payload?.via).toBe("staged");
    if (payload?.via !== "staged") throw new Error("expected staged");
    expect(bucket.objects.get(payload.key)?.byteLength).toBe(big.byteLength);
    expect(acks).toEqual([0]);
  });

  it("retries when a large snapshot cannot be staged (no WEBSUB_CONTENT binding)", async () => {
    const store = new MemoryStore();
    await store.upsert({
      callback: "https://sub.example/cb",
      topic,
      leaseSeconds: 1000,
      now: 0,
    });
    const big = new Uint8Array(100 * 1024).fill(97);
    const queue = new MemoryQueue();
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: distributingFetch(big, []) },
      { store, now: () => 500 },
    );
    const { batch, acks, retries } = batchOf([{ kind: "distribute", topic }]);
    await consumer(batch, envWith(queue), ctx); // no bucket
    expect(queue.sent).toEqual([]);
    expect(acks).toEqual([]);
    expect(retries).toEqual([0]);
  });

  it("retries the distribute job when the topic is unreachable", async () => {
    const store = new MemoryStore();
    const consumer = createWebSubQueueConsumer(
      {
        ...config,
        fetch: vi.fn(async () => new Response("", { status: 503 })),
      },
      { store },
    );
    const { batch, acks, retries } = batchOf([{ kind: "distribute", topic }]);
    await consumer(batch, envWith(new MemoryQueue()), ctx);
    expect(acks).toEqual([]);
    expect(retries).toEqual([0]);
  });

  it("acks (does not retry) when the topic is unlabelable and no fallback is set", async () => {
    const store = new MemoryStore();
    await store.upsert({
      callback: "https://sub.example/cb",
      topic,
      leaseSeconds: 1000,
      now: 0,
    });
    const queue = new MemoryQueue();
    const fetchImpl: FetchLike = vi.fn(async (_input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        // Byte-array body so no Content-Type is auto-set: an unlabelable topic.
        return new Response(new TextEncoder().encode("<feed/>"), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    });
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store, now: () => 500 },
    );
    const { batch, acks, retries } = batchOf([{ kind: "distribute", topic }]);
    await consumer(batch, envWith(queue), ctx);
    // Permanent refusal: schedule nothing, ack rather than retry.
    expect(queue.sent).toEqual([]);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  it("fails loudly when no store is configured", async () => {
    const consumer = createWebSubQueueConsumer(config);
    const { batch } = batchOf([{ kind: "distribute", topic }]);
    await expect(consumer(batch, {} as WebSubEnv, ctx)).rejects.toThrow(
      /WEBSUB_DB/,
    );
  });
});

describe("createWebSubQueueConsumer — deliver jobs", () => {
  const topic = "https://example.com/feed";

  it("decodes and POSTs an inline body (signed with the subscriber's secret) and acks", async () => {
    const posted: string[] = [];
    let seenSig: string | null = null;
    let seenBody: string | null = null;
    const fetchImpl: FetchLike = vi.fn(async (input, init) => {
      posted.push(input);
      seenSig = new Headers(init?.headers as HeadersInit).get(
        "x-hub-signature",
      );
      seenBody = new TextDecoder().decode(init?.body as ArrayBuffer);
      return new Response(null, { status: 204 });
    });
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store: new MemoryStore() },
    );
    const { batch, acks } = batchOf([
      {
        kind: "deliver",
        callback: "https://sub.example/cb",
        topic,
        secret: "sek",
        contentType: "application/atom+xml",
        payload: {
          via: "inline",
          body: encodeInlineBody(new TextEncoder().encode("<feed/>")),
        },
      },
    ]);
    await consumer(batch, {} as WebSubEnv, ctx);
    expect(posted).toEqual(["https://sub.example/cb"]);
    // The base64 payload was decoded back to the exact original bytes.
    expect(seenBody).toBe("<feed/>");
    expect(seenSig).toMatch(/^sha256=/);
    expect(acks).toEqual([0]);
  });

  it("retries a deliver job whose POST fails", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error("callback down");
    });
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store: new MemoryStore() },
    );
    const { batch, acks, retries } = batchOf([
      {
        kind: "deliver",
        callback: "https://sub.example/cb",
        topic,
        secret: null,
        contentType: "application/atom+xml",
        payload: {
          via: "inline",
          body: encodeInlineBody(new TextEncoder().encode("x")),
        },
      },
    ]);
    await consumer(batch, {} as WebSubEnv, ctx);
    expect(acks).toEqual([]);
    expect(retries).toEqual([0]);
  });

  it("reads a staged body from R2 and delivers it", async () => {
    const bucket = new MemoryBucket();
    const key = "websub-staging/abc";
    await bucket.put(key, new TextEncoder().encode("<feed>staged</feed>"));
    let seenBody: string | null = null;
    const fetchImpl: FetchLike = vi.fn(async (_input, init) => {
      seenBody = new TextDecoder().decode(init?.body as ArrayBuffer);
      return new Response(null, { status: 204 });
    });
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store: new MemoryStore() },
    );
    const { batch, acks } = batchOf([
      {
        kind: "deliver",
        callback: "https://sub.example/cb",
        topic,
        secret: null,
        contentType: "application/atom+xml",
        payload: { via: "staged", key },
      },
    ]);
    await consumer(
      batch,
      { WEBSUB_CONTENT: bucket } as unknown as WebSubEnv,
      ctx,
    );
    expect(seenBody).toBe("<feed>staged</feed>");
    expect(acks).toEqual([0]);
  });

  it("drops (acks) a staged delivery whose snapshot was already reclaimed", async () => {
    const bucket = new MemoryBucket(); // key never written
    const posted: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      posted.push(input);
      return new Response(null, { status: 204 });
    });
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store: new MemoryStore() },
    );
    const { batch, acks, retries } = batchOf([
      {
        kind: "deliver",
        callback: "https://sub.example/cb",
        topic,
        secret: null,
        contentType: "application/atom+xml",
        payload: { via: "staged", key: "websub-staging/gone" },
      },
    ]);
    await consumer(
      batch,
      { WEBSUB_CONTENT: bucket } as unknown as WebSubEnv,
      ctx,
    );
    expect(posted).toEqual([]);
    expect(acks).toEqual([0]);
    expect(retries).toEqual([]);
  });

  it("retries a staged delivery when no WEBSUB_CONTENT binding is present", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () => new Response(null, { status: 204 }),
    );
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: fetchImpl },
      { store: new MemoryStore() },
    );
    const { batch, acks, retries } = batchOf([
      {
        kind: "deliver",
        callback: "https://sub.example/cb",
        topic,
        secret: null,
        contentType: "application/atom+xml",
        payload: { via: "staged", key: "websub-staging/x" },
      },
    ]);
    await consumer(batch, {} as WebSubEnv, ctx);
    expect(acks).toEqual([]);
    expect(retries).toEqual([0]);
  });
});

describe("createWebSubQueueConsumer — distribute → deliver end to end", () => {
  it("delivers a fanned-out inline snapshot to every subscriber", async () => {
    const topic = "https://example.com/feed";
    const store = new MemoryStore();
    await store.upsert({
      callback: "https://a.example/cb",
      topic,
      leaseSeconds: 1000,
      now: 0,
    });
    await store.upsert({
      callback: "https://b.example/cb",
      topic,
      leaseSeconds: 1000,
      now: 0,
    });
    const posted: string[] = [];
    const queue = new MemoryQueue();
    const consumer = createWebSubQueueConsumer(
      { ...config, fetch: distributingFetch("<feed/>", posted) },
      { store, now: () => 500 },
    );
    // 1) planner turns the distribute job into per-subscriber deliver jobs
    await consumer(
      batchOf([{ kind: "distribute", topic }]).batch,
      { WEBSUB_QUEUE: queue } as unknown as WebSubEnv,
      ctx,
    );
    // 2) run the enqueued deliver jobs → each POSTs
    await consumer(batchOf(deliverJobs(queue)).batch, {} as WebSubEnv, ctx);
    expect(posted.sort()).toEqual([
      "https://a.example/cb",
      "https://b.example/cb",
    ]);
  });
});
