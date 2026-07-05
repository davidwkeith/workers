import { describe, it, expect, vi } from "vitest";
import {
  createWebmention,
  createWebmentionQueueConsumer,
  type InboxStore,
  type VerifiedMention,
  type WebmentionEnv,
  type WebmentionJob,
} from "./index.js";
import type { FetchLike } from "@dwk/safe-fetch";
import type {
  ExecutionContext,
  Message,
  MessageBatch,
} from "@cloudflare/workers-types";

const config = { baseUrl: "https://example.com" };
const ctx = {} as ExecutionContext;

function envWithQueue() {
  const sent: WebmentionJob[] = [];
  const env = {
    WEBMENTION_QUEUE: {
      send: vi.fn(async (job: WebmentionJob) => {
        sent.push(job);
      }),
    },
  } as unknown as WebmentionEnv;
  return { env, sent };
}

function formPost(source?: string, target?: string): Request {
  const body = new URLSearchParams();
  if (source !== undefined) body.set("source", source);
  if (target !== undefined) body.set("target", target);
  return new Request("https://example.com/webmention", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

describe("createWebmention", () => {
  it("validates synchronously, enqueues, and returns 202", async () => {
    const handler = createWebmention(config);
    const { env, sent } = envWithQueue();
    const response = await handler(
      formPost("https://other.example/p", "https://example.com/article"),
      env,
      ctx,
    );
    expect(response.status).toBe(202);
    expect(sent).toEqual([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
      },
    ]);
  });

  it("rejects a foreign target with 400 and does not enqueue", async () => {
    const handler = createWebmention(config);
    const { env, sent } = envWithQueue();
    const response = await handler(
      formPost("https://other.example/p", "https://evil.example/article"),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("target_not_supported");
    expect(sent).toEqual([]);
  });

  it("rejects a non-form-urlencoded Content-Type with 400", async () => {
    const handler = createWebmention(config);
    const { env, sent } = envWithQueue();
    const body = new FormData();
    body.set("source", "https://other.example/p");
    body.set("target", "https://example.com/article");
    const response = await handler(
      // A FormData body makes the runtime set a multipart Content-Type.
      new Request("https://example.com/webmention", { method: "POST", body }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Content-Type");
    expect(sent).toEqual([]);
  });

  it("rejects non-POST methods with 405", async () => {
    const handler = createWebmention(config);
    const { env } = envWithQueue();
    const response = await handler(
      new Request("https://example.com/webmention", { method: "GET" }),
      env,
      ctx,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("fails loudly when the queue binding is missing", async () => {
    const handler = createWebmention(config);
    await expect(
      handler(
        formPost("https://other.example/p", "https://example.com/article"),
        {} as WebmentionEnv,
        ctx,
      ),
    ).rejects.toThrow(/WEBMENTION_QUEUE/);
  });
});

class MemoryInbox implements InboxStore {
  readonly mentions = new Map<string, VerifiedMention>();
  private key(s: string, t: string) {
    return `${s}\n${t}`;
  }
  async store(mention: VerifiedMention) {
    this.mentions.set(this.key(mention.source, mention.target), mention);
  }
  async remove(source: string, target: string) {
    this.mentions.delete(this.key(source, target));
  }
  async list() {
    return [...this.mentions.values()];
  }
}

function batchOf(jobs: WebmentionJob[]): {
  batch: MessageBatch<WebmentionJob>;
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
      }) as unknown as Message<WebmentionJob>,
  );
  return {
    batch: { messages } as unknown as MessageBatch<WebmentionJob>,
    acks,
    retries,
  };
}

describe("createWebmentionQueueConsumer", () => {
  it("stores a verified mention and acks", async () => {
    const inbox = new MemoryInbox();
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response('<a href="https://example.com/article">x</a>', {
          headers: { "content-type": "text/html" },
        }),
    );
    const consumer = createWebmentionQueueConsumer({
      ...config,
      inbox,
      fetch: fetchImpl,
    });
    const { batch, acks } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);

    const stored = await inbox.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.source).toBe("https://other.example/p");
    expect(acks).toEqual([0]);
  });

  it("removes a mention whose source no longer links", async () => {
    const inbox = new MemoryInbox();
    await inbox.store({
      source: "https://other.example/p",
      target: "https://example.com/article",
      verifiedAt: 1,
    });
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response("<p>link removed</p>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const consumer = createWebmentionQueueConsumer({
      ...config,
      inbox,
      fetch: fetchImpl,
    });
    const { batch, acks } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);

    expect(await inbox.list()).toEqual([]);
    expect(acks).toEqual([0]);
  });

  it("retries a job when verification throws", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error("boom");
    });
    // Force the catch path: even the fallback inbox.remove rejects.
    const throwingInbox: InboxStore = {
      store: () => Promise.reject(new Error("db down")),
      remove: () => Promise.reject(new Error("db down")),
      list: () => Promise.resolve([]),
    };
    const consumer = createWebmentionQueueConsumer({
      ...config,
      inbox: throwingInbox,
      fetch: fetchImpl,
    });
    const { batch, acks, retries } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);
    expect(acks).toEqual([]);
    expect(retries).toEqual([0]);
  });

  it("fails loudly when no inbox is configured", async () => {
    const consumer = createWebmentionQueueConsumer(config);
    const { batch } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
      },
    ]);
    await expect(consumer(batch, {} as WebmentionEnv, ctx)).rejects.toThrow(
      /inbox/,
    );
  });
});
