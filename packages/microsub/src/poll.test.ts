import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMicrosubQueueConsumer,
  type ConsumerOptions,
} from "./consumer.js";
import type { MicrosubEnv } from "./config.js";
import type { FetchLike } from "@dwk/safe-fetch";
import type { Jf2Entry } from "./jf2.js";
import { createMicrosubPoller } from "./poll.js";
import type { MicrosubJob, PollJob } from "./queue.js";
import { createMicrosubStore, type MicrosubStore } from "./store.js";

const config = { baseUrl: "https://example.com", me: "https://example.com/" };
const ctx = {} as ExecutionContext;
const controller = {} as Parameters<ReturnType<typeof createMicrosubPoller>>[0];

const JSON_FEED = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  items: [
    {
      id: "a",
      url: "https://f.example/a",
      title: "A",
      date_published: "2026-01-01T00:00:00Z",
    },
  ],
});

function feedFetch(status = 200): FetchLike {
  return vi.fn(async () =>
    status === 304
      ? new Response(null, { status: 304 })
      : new Response(JSON_FEED, {
          status,
          headers: { "content-type": "application/feed+json" },
        }),
  );
}

beforeEach(async () => {
  await createMicrosubStore(env as unknown as MicrosubEnv).init();
});

describe("createMicrosubPoller", () => {
  it("enqueues one poll job per distinct followed feed", async () => {
    const sent: MicrosubJob[] = [];
    const testEnv = {
      ...(env as unknown as MicrosubEnv),
      MICROSUB_QUEUE: {
        send: vi.fn(async (job: MicrosubJob) => void sent.push(job)),
      },
    } as unknown as MicrosubEnv;

    const store = createMicrosubStore(testEnv);
    const channel = await store.createChannel("C", 1);
    await store.addFollow(
      channel.uid,
      "https://f.example/atom",
      "https://f.example/",
      1,
    );
    await store.addFollow(
      channel.uid,
      "https://g.example/rss",
      "https://g.example/",
      1,
    );

    await createMicrosubPoller(config)(controller, testEnv, ctx);
    expect(sent.map((j) => (j as PollJob).feedUrl).sort()).toEqual([
      "https://f.example/atom",
      "https://g.example/rss",
    ]);
  });

  it("fails loudly without the queue binding", async () => {
    const broken = {
      ...(env as unknown as MicrosubEnv),
      MICROSUB_QUEUE: undefined,
    } as unknown as MicrosubEnv;
    await expect(
      createMicrosubPoller(config)(controller, broken, ctx),
    ).rejects.toThrow(/MICROSUB_QUEUE/);
  });
});

/** A minimal in-memory store covering just what the consumer calls. */
function fakeStore(): {
  store: MicrosubStore;
  inserts: Array<{ channel: string; entries: readonly Jf2Entry[] }>;
  cache: Map<string, { etag: string | null; lastModified: string | null }>;
} {
  const inserts: Array<{ channel: string; entries: readonly Jf2Entry[] }> = [];
  const cache = new Map<
    string,
    { etag: string | null; lastModified: string | null }
  >();
  const seen = new Set<string>();
  const store = {
    async getFeedCache(feedUrl: string) {
      return cache.get(feedUrl) ?? null;
    },
    async setFeedCache(
      feedUrl: string,
      etag: string | null,
      lastModified: string | null,
    ) {
      cache.set(feedUrl, { etag, lastModified });
    },
    async channelsForFeed() {
      return ["chan1"];
    },
    async insertItems(
      channel: string,
      _feed: string,
      entries: readonly Jf2Entry[],
    ) {
      const fresh = entries.filter((e) => !seen.has(e._id));
      for (const e of fresh) seen.add(e._id);
      inserts.push({ channel, entries: fresh });
      return fresh.length;
    },
  } as unknown as MicrosubStore;
  return { store, inserts, cache };
}

function batch(jobs: PollJob[]): {
  batch: Parameters<ReturnType<typeof createMicrosubQueueConsumer>>[0];
  acks: number[];
  retries: number[];
} {
  const acks: number[] = [];
  const retries: number[] = [];
  const messages = jobs.map((body, i) => ({
    body,
    ack: () => acks.push(i),
    retry: () => retries.push(i),
  }));
  return {
    batch: { messages } as unknown as Parameters<
      ReturnType<typeof createMicrosubQueueConsumer>
    >[0],
    acks,
    retries,
  };
}

describe("createMicrosubQueueConsumer", () => {
  function consumer(
    fetchStub: FetchLike,
    store: MicrosubStore,
    opts?: ConsumerOptions,
  ) {
    return createMicrosubQueueConsumer(
      { ...config, fetch: fetchStub },
      { store, ...opts },
    );
  }

  it("polls a feed and appends new entries, deduping across runs", async () => {
    const { store, inserts, cache } = fakeStore();
    const run = consumer(feedFetch(), store, { now: () => 1000 });

    const first = batch([{ kind: "poll", feedUrl: "https://f.example/atom" }]);
    await run(first.batch, env as unknown as MicrosubEnv, ctx);
    expect(first.acks).toEqual([0]);
    expect(inserts[0]?.entries).toHaveLength(1);
    expect(cache.get("https://f.example/atom")).toBeDefined();

    // A second poll of the same feed inserts nothing new (deduped).
    const second = batch([{ kind: "poll", feedUrl: "https://f.example/atom" }]);
    await run(second.batch, env as unknown as MicrosubEnv, ctx);
    expect(inserts[1]?.entries).toHaveLength(0);
  });

  it("acks a 304 with nothing inserted", async () => {
    const { store, inserts } = fakeStore();
    const run = consumer(feedFetch(304), store);
    const { batch: b, acks } = batch([
      { kind: "poll", feedUrl: "https://f.example/atom" },
    ]);
    await run(b, env as unknown as MicrosubEnv, ctx);
    expect(acks).toEqual([0]);
    expect(inserts).toHaveLength(0);
  });

  it("retries when the feed fetch fails", async () => {
    const { store } = fakeStore();
    const failing: FetchLike = vi.fn(
      async () => new Response("err", { status: 500 }),
    );
    const run = consumer(failing, store);
    const { batch: b, retries } = batch([
      { kind: "poll", feedUrl: "https://f.example/atom" },
    ]);
    await run(b, env as unknown as MicrosubEnv, ctx);
    expect(retries).toEqual([0]);
  });

  it("retries when the store throws", async () => {
    const store = {
      async getFeedCache() {
        throw new Error("d1 down");
      },
    } as unknown as MicrosubStore;
    const run = consumer(feedFetch(), store);
    const { batch: b, retries } = batch([
      { kind: "poll", feedUrl: "https://f.example/atom" },
    ]);
    await run(b, env as unknown as MicrosubEnv, ctx);
    expect(retries).toEqual([0]);
  });

  it("fails loudly without a store or DB binding", () => {
    const broken = {
      ...(env as unknown as MicrosubEnv),
      MICROSUB_DB: undefined,
    } as unknown as MicrosubEnv;
    const run = createMicrosubQueueConsumer(config);
    const { batch: b } = batch([
      { kind: "poll", feedUrl: "https://f.example/atom" },
    ]);
    return expect(run(b, broken, ctx)).rejects.toThrow(/MICROSUB_DB/);
  });
});
