/**
 * Phase 3 end-to-end: the lifecycle shims drive real package consumers and
 * scheduled handlers, bound to the host's `Env` via {@link bindQueueConsumer} /
 * {@link bindScheduledTask}.
 *
 * This is the bring-up acceptance for the async/scheduled packages on Node:
 *   - a Webmention is received (sync) and verified asynchronously off the queue
 *     into the inbox, through the running host;
 *   - the Microsub scheduled poller fans out poll jobs that the consumer turns
 *     into timeline items;
 *   - the WebSub consumer distributes a signed payload to a subscriber;
 *   - the R2 GC cron reclaims an orphaned blob from the filesystem-R2 shim.
 *
 * Outbound `fetch` is stubbed (the packages take an injected `fetch`), so these
 * run with no network — the SSRF guard is a synchronous hostname check, so
 * public-looking names reach the stub. The host installs a WASM `HTMLRewriter`
 * global (see `createServer`), so webmention's HTML link verification runs on
 * Node.
 *
 * @see spec/self-hosting.md §7.5
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

import {
  createWebmention,
  createWebmentionQueueConsumer,
  createD1Inbox,
} from "@dwk/webmention";
import {
  createMicrosubPoller,
  createMicrosubQueueConsumer,
  createMicrosubStore,
} from "@dwk/microsub";
import {
  createWebSubQueueConsumer,
  createD1SubscriptionStore,
} from "@dwk/websub";
import { collectGarbage, ensureGcSchema, d1OrphanSink } from "@dwk/store";

import { createServer } from "./server.js";
import { assembleBindings } from "./bindings.js";
import { bindQueueConsumer, bindScheduledTask } from "./lifecycle.js";
import { WaitUntilTracker } from "./context.js";
import { QueueBroker, CronScheduler } from "@dwk/cf-shims";
import type { FetchHandler } from "./config.js";

const tempDirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-phase3-"));
  tempDirs.push(dir);
  return dir;
}

/** A minimal `fetch` whose route table the individual tests supply. */
function stubFetch(
  routes: (url: string, init: RequestInit | undefined) => Response | undefined,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const merged: RequestInit | undefined =
      input instanceof Request ? { headers: input.headers } : init;
    return routes(url, merged) ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
}

/** Send a job through a producer binding without importing the `Queue` type. */
async function enqueue(binding: unknown, job: unknown): Promise<void> {
  await (binding as { send(m: unknown): Promise<void> }).send(job);
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("Phase 3 — lifecycle bring-up on the shims", () => {
  it("verifies a received Webmention asynchronously off the queue", async () => {
    const dir = dataDir();
    const env = assembleBindings({ dataDir: dir, d1: ["WEBMENTION_INBOX"] });
    const tracker = new WaitUntilTracker();
    const broker = new QueueBroker();
    env.WEBMENTION_QUEUE = broker.producer("WEBMENTION_QUEUE");

    const source = "https://source.example/post";
    const target = "http://localhost/hello";
    const config = {
      baseUrl: "http://localhost",
      fetch: stubFetch((url) =>
        url === source
          ? new Response(
              `<html><body><a href="${target}">re</a></body></html>`,
              { headers: { "content-type": "text/html" } },
            )
          : undefined,
      ),
    };

    // Wire the (Phase 3) verification consumer into the host lifecycle.
    broker.consumer(
      "WEBMENTION_QUEUE",
      bindQueueConsumer(createWebmentionQueueConsumer(config), env, tracker),
    );

    const server = createServer({
      baseUrl: "http://localhost",
      dataDir: dir,
      env,
      tracker,
      queue: broker,
      mounts: [
        {
          name: "@dwk/webmention",
          handler: createWebmention(config) as unknown as FetchHandler,
          reservedPaths: ["/webmention"],
          requires: ["WEBMENTION_QUEUE", "WEBMENTION_INBOX"],
        },
      ],
    });
    const { port } = await server.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;

    try {
      // Sync receive → 202 + enqueued; nothing verified yet.
      const res = await fetch(`${base}/webmention`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ source, target }).toString(),
      });
      expect(res.status).toBe(202);
      expect(broker.pending("WEBMENTION_QUEUE")).toBe(1);

      // The queue consumer fetches the source, scans it (HTMLRewriter global is
      // installed by the host), finds the link, and stores the mention.
      await broker.tick();
      expect(broker.pending("WEBMENTION_QUEUE")).toBe(0);

      const mentions = await createD1Inbox(
        env.WEBMENTION_INBOX as D1Database,
      ).list();
      expect(mentions.map((m) => m.source)).toContain(source);
    } finally {
      // Always release the listener + single-writer lock, even on assertion fail.
      await server.close();
    }
  });

  it("populates a Microsub timeline from a scheduled poll", async () => {
    const dir = dataDir();
    const env = assembleBindings({ dataDir: dir, d1: ["MICROSUB_DB"] });
    const tracker = new WaitUntilTracker();
    const broker = new QueueBroker();
    env.MICROSUB_QUEUE = broker.producer("MICROSUB_QUEUE");

    const store = createMicrosubStore(env as never);
    await store.init();
    const now = Math.floor(Date.now() / 1000);
    const channel = await store.createChannel("Reading", now);
    const feedUrl = "https://feed.example/jsonfeed";
    await store.addFollow(channel.uid, feedUrl, feedUrl, now);

    const jsonFeed = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "Example",
      items: [
        {
          id: "post-1",
          url: "https://feed.example/1",
          content_text: "Hello from the feed",
          date_published: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const config = {
      baseUrl: "http://localhost",
      me: "https://alice.example.com/",
      fetch: stubFetch((url) =>
        url === feedUrl
          ? new Response(jsonFeed, {
              headers: { "content-type": "application/feed+json" },
            })
          : undefined,
      ),
    };

    const cron = new CronScheduler();
    cron.register(
      bindScheduledTask(createMicrosubPoller(config), env, tracker),
      60_000,
      "*/5 * * * *",
    );
    broker.consumer(
      "MICROSUB_QUEUE",
      bindQueueConsumer(createMicrosubQueueConsumer(config), env, tracker),
    );

    // Scheduled poll fans out one job per followed feed.
    await cron.fireAll();
    expect(broker.pending("MICROSUB_QUEUE")).toBe(1);

    // The consumer fetches the feed and appends to the channel timeline.
    await broker.tick();
    const page = await store.listItems(channel.uid, { limit: 10 });
    expect(page.items.length).toBeGreaterThan(0);
  });

  it("distributes a signed WebSub payload to a subscriber", async () => {
    const dir = dataDir();
    const env = assembleBindings({ dataDir: dir, d1: ["WEBSUB_DB"] });
    const tracker = new WaitUntilTracker();
    const broker = new QueueBroker();
    env.WEBSUB_QUEUE = broker.producer("WEBSUB_QUEUE");

    const topic = "https://feed.example/feed";
    const callback = "https://subscriber.example/cb";
    await createD1SubscriptionStore(env.WEBSUB_DB as D1Database).upsert({
      callback,
      topic,
      secret: "s3cret",
      leaseSeconds: 3600,
      now: Date.now(),
    });

    let signature: string | null = null;
    const config = {
      baseUrl: "http://localhost",
      hubUrl: "http://localhost/websub",
      allowedTopics: [topic],
      fetch: stubFetch((url, init) => {
        if (url === topic) {
          return new Response("<feed>updated</feed>", {
            headers: { "content-type": "application/atom+xml" },
          });
        }
        if (url === callback) {
          signature = new Headers(init?.headers).get("x-hub-signature");
          return new Response(null, { status: 204 });
        }
        return undefined;
      }),
    };

    broker.consumer(
      "WEBSUB_QUEUE",
      bindQueueConsumer(createWebSubQueueConsumer(config), env, tracker),
    );

    await enqueue(env.WEBSUB_QUEUE, { kind: "distribute", topic });
    // The distribute job is a fan-out planner: it enqueues one per-subscriber
    // deliver job, so drain the queue until it settles rather than ticking once.
    for (let i = 0; i < 5 && broker.pending("WEBSUB_QUEUE") > 0; i++) {
      await broker.tick();
    }

    // The subscriber received an HMAC-signed delivery.
    expect(signature).toMatch(/^sha(1|256)=/);
  });

  it("reclaims an orphaned R2 blob from the GC cron", async () => {
    const dir = dataDir();
    const env = assembleBindings({
      dataDir: dir,
      d1: ["GC_DB"],
      r2: ["BLOBS"],
    });
    const tracker = new WaitUntilTracker();

    await ensureGcSchema(env.GC_DB as D1Database);
    const blobKey = `gc/blobs/sha256-${crypto.randomUUID()}`;
    await (env.BLOBS as R2Bucket).put(
      blobKey,
      new TextEncoder().encode("junk"),
    );
    await d1OrphanSink(env.GC_DB as D1Database).enqueue([
      { blobKey, enqueuedAt: Date.now() },
    ]);

    // The GC cron mirrors `@dwk/solid-pod`'s `createSolidPodGc`: it touches only
    // D1 + R2, never a Durable Object.
    const cron = new CronScheduler();
    cron.register(
      bindScheduledTask(
        async (_event, e, _ctx) => {
          const gcEnv = e as unknown as {
            GC_DB: D1Database;
            BLOBS: R2Bucket;
          };
          await ensureGcSchema(gcEnv.GC_DB);
          await collectGarbage(gcEnv, { safetyWindowMs: 0 });
        },
        env,
        tracker,
      ),
      3_600_000,
      "0 * * * *",
    );

    expect(await (env.BLOBS as R2Bucket).get(blobKey)).not.toBeNull();
    await cron.fireAll();
    expect(await (env.BLOBS as R2Bucket).get(blobKey)).toBeNull();
  });
});
