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

function formPost(source?: string, target?: string, vouch?: string): Request {
  const body = new URLSearchParams();
  if (source !== undefined) body.set("source", source);
  if (target !== undefined) body.set("target", target);
  if (vouch !== undefined) body.set("vouch", vouch);
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

  it("includes a syntactically valid vouch URL in the enqueued job", async () => {
    const handler = createWebmention(config);
    const { env, sent } = envWithQueue();
    const response = await handler(
      formPost(
        "https://other.example/p",
        "https://example.com/article",
        "https://vouches.example/for-me",
      ),
      env,
      ctx,
    );
    expect(response.status).toBe(202);
    expect(sent).toEqual([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
        vouch: "https://vouches.example/for-me",
      },
    ]);
  });

  it("drops a malformed vouch URL instead of rejecting the mention", async () => {
    const handler = createWebmention(config);
    const { env, sent } = envWithQueue();
    const response = await handler(
      formPost(
        "https://other.example/p",
        "https://example.com/article",
        "not-a-url",
      ),
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

function batchOf(
  jobs: WebmentionJob[],
  attempts: readonly number[] = [],
): {
  batch: MessageBatch<WebmentionJob>;
  acks: number[];
  retries: number[];
  retryDelays: (number | undefined)[];
} {
  const acks: number[] = [];
  const retries: number[] = [];
  const retryDelays: (number | undefined)[] = [];
  const messages = jobs.map(
    (body, i) =>
      ({
        body,
        attempts: attempts[i] ?? 1,
        ack: () => acks.push(i),
        retry: (options?: { delaySeconds?: number }) => {
          retries.push(i);
          retryDelays.push(options?.delaySeconds);
        },
      }) as unknown as Message<WebmentionJob>,
  );
  return {
    batch: { messages } as unknown as MessageBatch<WebmentionJob>,
    acks,
    retries,
    retryDelays,
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
    // A bare link is a plain mention; published falls back to verification.
    expect(stored[0]?.interactionType).toBe("mention");
    expect(stored[0]?.publishedAt).toBe(stored[0]?.verifiedAt);
    expect(acks).toEqual([0]);
  });

  it("stores enrichment from the source's h-entry, with declared published", async () => {
    const inbox = new MemoryInbox();
    const html =
      '<div class="h-entry">' +
      '<a class="u-in-reply-to" href="https://example.com/article">re</a>' +
      '<time class="dt-published" datetime="2026-07-01T10:00:00Z">Jul 1</time>' +
      '<div class="e-content">Nice <em>post</em></div>' +
      '<div class="p-author h-card"><span class="p-name">Replier</span></div>' +
      "</div>";
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response(html, { headers: { "content-type": "text/html" } }),
    );
    const consumer = createWebmentionQueueConsumer({
      ...config,
      inbox,
      fetch: fetchImpl,
    });
    const { batch } = batchOf([
      {
        source: "https://other.example/reply",
        target: "https://example.com/article",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);

    const [stored] = await inbox.list();
    expect(stored?.interactionType).toBe("reply");
    expect(stored?.author).toEqual({ name: "Replier" });
    expect(stored?.content).toBe("Nice <em>post</em>");
    expect(stored?.publishedAt).toBe(Date.parse("2026-07-01T10:00:00Z"));
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

  it("backs off exponentially, capped, based on message.attempts", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error("boom");
    });
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
    const job = {
      source: "https://other.example/p",
      target: "https://example.com/article",
    };
    const { batch, retryDelays } = batchOf([job, job, job, job], [1, 2, 3, 20]);
    await consumer(batch, {} as WebmentionEnv, ctx);
    expect(retryDelays).toEqual([30, 60, 120, 3600]);
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

  it("verifies and stores a vouch when the job includes one and the mention verifies", async () => {
    const inbox = new MemoryInbox();
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      const url = String(input);
      if (url === "https://vouches.example/for-me") {
        return new Response(
          '<a href="https://other.example/p">I trust this</a>',
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response('<a href="https://example.com/article">x</a>', {
        headers: { "content-type": "text/html" },
      });
    });
    const consumer = createWebmentionQueueConsumer({
      ...config,
      inbox,
      fetch: fetchImpl,
      isTrustedVouchDomain: () => true,
    });
    const { batch } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
        vouch: "https://vouches.example/for-me",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);

    const [stored] = await inbox.list();
    expect(stored?.vouch).toEqual({
      url: "https://vouches.example/for-me",
      verified: true,
    });
  });

  it("stores a failed vouch outcome without affecting the mention itself", async () => {
    const inbox = new MemoryInbox();
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      const url = String(input);
      if (url === "https://vouches.example/for-me") {
        return new Response('<a href="https://elsewhere.example/">x</a>', {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response('<a href="https://example.com/article">x</a>', {
        headers: { "content-type": "text/html" },
      });
    });
    const consumer = createWebmentionQueueConsumer({
      ...config,
      inbox,
      fetch: fetchImpl,
      isTrustedVouchDomain: () => true,
    });
    const { batch } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
        vouch: "https://vouches.example/for-me",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);

    const [stored] = await inbox.list();
    expect(stored?.vouch).toEqual({
      url: "https://vouches.example/for-me",
      verified: false,
    });
    expect(stored?.source).toBe("https://other.example/p");
  });

  it("stores no vouch field when the job carries none", async () => {
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
    const { batch } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);

    const [stored] = await inbox.list();
    expect(stored?.vouch).toBeUndefined();
  });

  it("never fetches the vouch URL when the source itself does not verify", async () => {
    const inbox = new MemoryInbox();
    const fetchedUrls: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      fetchedUrls.push(String(input));
      return new Response("<p>link removed</p>", {
        headers: { "content-type": "text/html" },
      });
    });
    const consumer = createWebmentionQueueConsumer({
      ...config,
      inbox,
      fetch: fetchImpl,
    });
    const { batch } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
        vouch: "https://vouches.example/for-me",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);

    expect(fetchedUrls).toEqual(["https://other.example/p"]);
  });

  it("does not verify vouch when isTrustedVouchDomain is not configured (defaults to always-untrusted)", async () => {
    const inbox = new MemoryInbox();
    const fetchedUrls: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      fetchedUrls.push(String(input));
      return new Response('<a href="https://example.com/article">x</a>', {
        headers: { "content-type": "text/html" },
      });
    });
    const consumer = createWebmentionQueueConsumer({
      ...config,
      inbox,
      fetch: fetchImpl,
      // isTrustedVouchDomain intentionally omitted
    });
    const { batch } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
        vouch: "https://vouches.example/for-me",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);

    const [stored] = await inbox.list();
    expect(stored?.vouch).toEqual({
      url: "https://vouches.example/for-me",
      verified: false,
    });
    // The vouch URL itself must never be fetched when it's untrusted (Task 1's contract) —
    // only the source URL should appear.
    expect(fetchedUrls).toEqual(["https://other.example/p"]);
  });

  it("verifies vouch against the source's domain, not the target's", async () => {
    const inbox = new MemoryInbox();
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      const url = String(input);
      if (url === "https://vouches.example/for-me") {
        // Links to the SOURCE, not the target — this must verify true only because
        // isTrustedVouchDomain is configured and the match is against source.
        return new Response(
          '<a href="https://other.example/p">I trust this sender</a>',
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response('<a href="https://example.com/article">x</a>', {
        headers: { "content-type": "text/html" },
      });
    });
    const consumer = createWebmentionQueueConsumer({
      ...config,
      inbox,
      fetch: fetchImpl,
      isTrustedVouchDomain: () => true,
    });
    const { batch } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
        vouch: "https://vouches.example/for-me",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);

    const [stored] = await inbox.list();
    expect(stored?.vouch).toEqual({
      url: "https://vouches.example/for-me",
      verified: true,
    });
  });

  it("passes the vouch URL's hostname to isTrustedVouchDomain", async () => {
    const inbox = new MemoryInbox();
    const seenHostnames: string[] = [];
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
      isTrustedVouchDomain: (hostname) => {
        seenHostnames.push(hostname);
        return true;
      },
    });
    const { batch } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
        vouch: "https://vouches.example/for-me",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);

    expect(seenHostnames).toEqual(["vouches.example"]);
  });
});
