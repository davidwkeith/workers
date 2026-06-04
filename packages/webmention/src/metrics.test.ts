import { describe, it, expect, vi } from "vitest";
import type {
  ExecutionContext,
  Message,
  MessageBatch,
} from "@cloudflare/workers-types";
import {
  createWebmention,
  createWebmentionQueueConsumer,
  safeFetch,
  sendWebmention,
  verifySource,
  WebmentionLogEvent,
  type InboxStore,
  type Metrics,
  type WebmentionEnv,
  type WebmentionJob,
} from "./index";
import type { FetchLike } from "./fetch";

type MetricRecord = {
  kind: "count" | "observe";
  event: string;
  value?: number;
  fields?: { [k: string]: unknown };
};

function captureMetrics(): Metrics & { records: MetricRecord[] } {
  const records: MetricRecord[] = [];
  return {
    records,
    count: (event, fields) => records.push({ kind: "count", event, fields }),
    observe: (event, value, fields) =>
      records.push({ kind: "observe", event, value, fields }),
  };
}

const find = (records: MetricRecord[], event: string) =>
  records.find((r) => r.event === event);

const ctx = {} as ExecutionContext;

describe("safeFetch SSRF metrics", () => {
  it("counts ssrf.blocked with reason and sanitized host", async () => {
    const metrics = captureMetrics();
    const doFetch: FetchLike = vi.fn(async () => new Response("ok"));
    await expect(
      safeFetch(
        doFetch,
        "http://169.254.169.254/latest",
        { method: "GET" },
        { metrics },
      ),
    ).rejects.toBeInstanceOf(Error);
    const rec = find(metrics.records, WebmentionLogEvent.SsrfBlocked);
    expect(rec?.kind).toBe("count");
    expect(rec?.fields).toMatchObject({
      reason: "blocked_host",
      host: "169.254.169.254",
    });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("does not count ssrf.blocked for an ordinary network failure", async () => {
    const metrics = captureMetrics();
    const doFetch: FetchLike = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await expect(
      safeFetch(
        doFetch,
        "https://example.com/",
        { method: "GET" },
        { metrics },
      ),
    ).rejects.toThrow("connection reset");
    expect(
      find(metrics.records, WebmentionLogEvent.SsrfBlocked),
    ).toBeUndefined();
  });
});

describe("verifySource metrics", () => {
  it("counts verify.completed with links and status", async () => {
    const metrics = captureMetrics();
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response('<a href="https://example.com/article">x</a>', {
          headers: { "content-type": "text/html" },
        }),
    );
    await verifySource(
      "https://blog.example/post",
      "https://example.com/article",
      { fetch: fetchImpl, metrics },
    );
    expect(
      find(metrics.records, WebmentionLogEvent.VerifyCompleted)?.fields,
    ).toMatchObject({
      sourceHost: "blog.example",
      targetHost: "example.com",
      links: true,
      status: 200,
    });
  });
});

describe("sendWebmention metrics", () => {
  it("counts send.completed when a target declares no endpoint", async () => {
    const metrics = captureMetrics();
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response("<p>no endpoint here</p>", {
          headers: { "content-type": "text/html" },
        }),
    );
    await sendWebmention(
      "https://me.example/post",
      "https://them.example/article",
      { fetch: fetchImpl, metrics },
    );
    expect(
      find(metrics.records, WebmentionLogEvent.SendCompleted)?.fields,
    ).toMatchObject({
      targetHost: "them.example",
      delivered: false,
      status: 0,
    });
  });
});

function formPost(source: string, target: string): Request {
  const body = new URLSearchParams({ source, target });
  return new Request("https://example.com/webmention", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

function envWithQueue(): WebmentionEnv {
  return {
    WEBMENTION_QUEUE: { send: vi.fn(async () => {}) },
  } as unknown as WebmentionEnv;
}

describe("createWebmention metrics", () => {
  it("counts receive.accepted on a valid mention", async () => {
    const metrics = captureMetrics();
    const handler = createWebmention({
      baseUrl: "https://example.com",
      metrics,
    });
    await handler(
      formPost("https://other.example/p", "https://example.com/article"),
      envWithQueue(),
      ctx,
    );
    expect(
      find(metrics.records, WebmentionLogEvent.ReceiveAccepted)?.fields,
    ).toMatchObject({ sourceHost: "other.example", targetHost: "example.com" });
  });

  it("counts receive.rejected with a reason on a foreign target", async () => {
    const metrics = captureMetrics();
    const handler = createWebmention({
      baseUrl: "https://example.com",
      metrics,
    });
    await handler(
      formPost("https://other.example/p", "https://evil.example/article"),
      envWithQueue(),
      ctx,
    );
    const rec = find(metrics.records, WebmentionLogEvent.ReceiveRejected);
    expect(rec?.kind).toBe("count");
    expect(String(rec?.fields?.reason)).toContain("target_not_supported");
  });
});

function batchOf(jobs: WebmentionJob[]) {
  const retries: number[] = [];
  const messages = jobs.map(
    (body, i) =>
      ({
        body,
        ack: () => {},
        retry: () => retries.push(i),
      }) as unknown as Message<WebmentionJob>,
  );
  return {
    batch: { messages } as unknown as MessageBatch<WebmentionJob>,
    retries,
  };
}

describe("createWebmentionQueueConsumer metrics", () => {
  it("counts queue.retry instead of swallowing a poison message", async () => {
    const metrics = captureMetrics();
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error("boom");
    });
    const throwingInbox: InboxStore = {
      store: () => Promise.reject(new Error("db down")),
      remove: () => Promise.reject(new Error("db down")),
      list: () => Promise.resolve([]),
    };
    const consumer = createWebmentionQueueConsumer({
      baseUrl: "https://example.com",
      inbox: throwingInbox,
      fetch: fetchImpl,
      metrics,
    });
    const { batch, retries } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);
    expect(retries).toEqual([0]);
    const rec = find(metrics.records, WebmentionLogEvent.QueueRetry);
    expect(rec?.kind).toBe("count");
    expect(rec?.fields).toMatchObject({ targetHost: "example.com" });
  });
});
