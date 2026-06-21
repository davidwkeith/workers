import { describe, it, expect, vi } from "vitest";
import { createWebSub, createPublishNotifier } from "./handler.js";
import type { WebSubEnv } from "./config.js";
import type { WebSubJob } from "./queue.js";
import type { ExecutionContext } from "@cloudflare/workers-types";

const config = {
  baseUrl: "https://hub.example",
  allowedTopics: ["https://example.com/feed"],
};
const ctx = {} as ExecutionContext;

function envWithQueue() {
  const sent: WebSubJob[] = [];
  const env = {
    WEBSUB_QUEUE: {
      send: vi.fn(async (job: WebSubJob) => {
        sent.push(job);
      }),
    },
  } as unknown as WebSubEnv;
  return { env, sent };
}

function formPost(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("https://hub.example/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

describe("createWebSub", () => {
  it("accepts a subscribe, enqueues a verify job, returns 202", async () => {
    const handler = createWebSub(config);
    const { env, sent } = envWithQueue();
    const response = await handler(
      formPost({
        "hub.mode": "subscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://example.com/feed",
        "hub.secret": "s3cr3t",
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(202);
    expect(sent).toEqual([
      {
        kind: "verify",
        mode: "subscribe",
        callback: "https://sub.example/cb",
        topic: "https://example.com/feed",
        leaseSeconds: 864000,
        secret: "s3cr3t",
      },
    ]);
  });

  it("accepts an unsubscribe", async () => {
    const handler = createWebSub(config);
    const { env, sent } = envWithQueue();
    const response = await handler(
      formPost({
        "hub.mode": "unsubscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://example.com/feed",
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(202);
    expect(sent[0]?.kind).toBe("verify");
    expect((sent[0] as { mode: string }).mode).toBe("unsubscribe");
  });

  it("accepts a publish ping and enqueues a distribute job", async () => {
    const handler = createWebSub(config);
    const { env, sent } = envWithQueue();
    const response = await handler(
      formPost({
        "hub.mode": "publish",
        "hub.url": "https://example.com/feed",
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(202);
    expect(sent).toEqual([
      { kind: "distribute", topic: "https://example.com/feed" },
    ]);
  });

  it("rejects an unsupported topic with 400 and does not enqueue", async () => {
    const handler = createWebSub(config);
    const { env, sent } = envWithQueue();
    const response = await handler(
      formPost({
        "hub.mode": "subscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://evil.example/feed",
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("topic_not_supported");
    expect(sent).toEqual([]);
  });

  it("rejects a missing mode with 400", async () => {
    const handler = createWebSub(config);
    const { env } = envWithQueue();
    const response = await handler(
      formPost({ "hub.callback": "https://sub.example/cb" }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid_mode");
  });

  it("rejects non-POST with 405", async () => {
    const handler = createWebSub(config);
    const { env } = envWithQueue();
    const response = await handler(
      new Request("https://hub.example/", { method: "GET" }),
      env,
      ctx,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("fails loudly when the queue binding is missing", async () => {
    const handler = createWebSub(config);
    await expect(
      handler(
        formPost({
          "hub.mode": "subscribe",
          "hub.callback": "https://sub.example/cb",
          "hub.topic": "https://example.com/feed",
        }),
        {} as WebSubEnv,
        ctx,
      ),
    ).rejects.toThrow(/WEBSUB_QUEUE/);
  });
});

describe("createPublishNotifier", () => {
  it("enqueues a distribute job for a supported topic", async () => {
    const notify = createPublishNotifier(config);
    const { env, sent } = envWithQueue();
    await notify(env, "https://example.com/feed");
    expect(sent).toEqual([
      { kind: "distribute", topic: "https://example.com/feed" },
    ]);
  });

  it("throws for an unsupported topic", async () => {
    const notify = createPublishNotifier(config);
    const { env, sent } = envWithQueue();
    await expect(notify(env, "https://evil.example/feed")).rejects.toThrow(
      /unsupported topic/,
    );
    expect(sent).toEqual([]);
  });
});
