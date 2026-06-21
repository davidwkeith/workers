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
  type Logger,
  type WebmentionEnv,
  type WebmentionJob,
} from "./index.js";
import type { FetchLike } from "./fetch.js";

type LogRecord = {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields?: { [k: string]: unknown };
};

function captureLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const push =
    (level: LogRecord["level"]) =>
    (event: string, fields?: { [k: string]: unknown }) =>
      records.push({ level, event, fields });
  return {
    records,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

const find = (records: LogRecord[], event: string) =>
  records.find((r) => r.event === event);

const ctx = {} as ExecutionContext;

describe("safeFetch SSRF logging", () => {
  it("logs ssrf.blocked with reason and sanitized host for a blocked host", async () => {
    const logger = captureLogger();
    const doFetch: FetchLike = vi.fn(async () => new Response("ok"));
    await expect(
      safeFetch(
        doFetch,
        "http://169.254.169.254/latest",
        { method: "GET" },
        { logger },
      ),
    ).rejects.toBeInstanceOf(Error);
    const rec = find(logger.records, WebmentionLogEvent.SsrfBlocked);
    expect(rec?.level).toBe("warn");
    expect(rec?.fields).toMatchObject({
      reason: "blocked_host",
      host: "169.254.169.254",
    });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("logs ssrf.blocked when a redirect points at an internal host", async () => {
    const logger = captureLogger();
    const doFetch = vi.fn<FetchLike>(async (url) =>
      url === "https://public.example/"
        ? new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/" },
          })
        : new Response("nope"),
    );
    await expect(
      safeFetch(
        doFetch,
        "https://public.example/",
        { method: "GET" },
        { logger },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(
      find(logger.records, WebmentionLogEvent.SsrfBlocked)?.fields,
    ).toMatchObject({ reason: "blocked_host", host: "127.0.0.1" });
  });

  it("logs reason too_many_redirects when the hop cap is exceeded", async () => {
    const logger = captureLogger();
    const doFetch: FetchLike = vi.fn(async (url) => {
      const next = new URL(url);
      next.pathname += "x";
      return new Response(null, {
        status: 302,
        headers: { location: next.toString() },
      });
    });
    await expect(
      safeFetch(
        doFetch,
        "https://loop.example/",
        { method: "GET" },
        { logger, maxRedirects: 2 },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(
      find(logger.records, WebmentionLogEvent.SsrfBlocked)?.fields,
    ).toMatchObject({ reason: "too_many_redirects" });
  });

  it("does not log ssrf.blocked for an ordinary network failure", async () => {
    const logger = captureLogger();
    const doFetch: FetchLike = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await expect(
      safeFetch(doFetch, "https://example.com/", { method: "GET" }, { logger }),
    ).rejects.toThrow("connection reset");
    expect(
      find(logger.records, WebmentionLogEvent.SsrfBlocked),
    ).toBeUndefined();
  });
});

describe("verifySource logging", () => {
  it("logs verify.completed with links and status", async () => {
    const logger = captureLogger();
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response('<a href="https://example.com/article">x</a>', {
          headers: { "content-type": "text/html" },
        }),
    );
    await verifySource(
      "https://blog.example/post",
      "https://example.com/article",
      { fetch: fetchImpl, logger },
    );
    expect(
      find(logger.records, WebmentionLogEvent.VerifyCompleted)?.fields,
    ).toMatchObject({
      sourceHost: "blog.example",
      targetHost: "example.com",
      links: true,
      status: 200,
    });
  });

  it("distinguishes a blocked source: warns ssrf.blocked and notes the failure", async () => {
    const logger = captureLogger();
    // The source itself is an internal address, so safeFetch blocks before fetch.
    const fetchImpl: FetchLike = vi.fn(async () => new Response("unused"));
    const result = await verifySource(
      "http://169.254.169.254/latest",
      "https://example.com/article",
      { fetch: fetchImpl, logger },
    );
    expect(result).toEqual({ links: false, status: 0 });
    expect(find(logger.records, WebmentionLogEvent.SsrfBlocked)?.level).toBe(
      "warn",
    );
    expect(
      find(logger.records, WebmentionLogEvent.VerifyFetchFailed),
    ).toBeDefined();
  });
});

describe("sendWebmention logging", () => {
  it("logs send.completed when a target declares no endpoint", async () => {
    const logger = captureLogger();
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response("<p>no endpoint here</p>", {
          headers: { "content-type": "text/html" },
        }),
    );
    await sendWebmention(
      "https://me.example/post",
      "https://them.example/article",
      { fetch: fetchImpl, logger },
    );
    expect(
      find(logger.records, WebmentionLogEvent.SendCompleted)?.fields,
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

describe("createWebmention logging", () => {
  it("logs receive.accepted on a valid mention", async () => {
    const logger = captureLogger();
    const handler = createWebmention({
      baseUrl: "https://example.com",
      logger,
    });
    await handler(
      formPost("https://other.example/p", "https://example.com/article"),
      envWithQueue(),
      ctx,
    );
    expect(
      find(logger.records, WebmentionLogEvent.ReceiveAccepted)?.fields,
    ).toMatchObject({ sourceHost: "other.example", targetHost: "example.com" });
  });

  it("logs receive.rejected with a reason on a foreign target", async () => {
    const logger = captureLogger();
    const handler = createWebmention({
      baseUrl: "https://example.com",
      logger,
    });
    await handler(
      formPost("https://other.example/p", "https://evil.example/article"),
      envWithQueue(),
      ctx,
    );
    const rec = find(logger.records, WebmentionLogEvent.ReceiveRejected);
    expect(rec?.level).toBe("warn");
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

describe("createWebmentionQueueConsumer logging", () => {
  it("logs queue.retry instead of swallowing a poison message", async () => {
    const logger = captureLogger();
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
      logger,
    });
    const { batch, retries } = batchOf([
      {
        source: "https://other.example/p",
        target: "https://example.com/article",
      },
    ]);
    await consumer(batch, {} as WebmentionEnv, ctx);
    expect(retries).toEqual([0]);
    const rec = find(logger.records, WebmentionLogEvent.QueueRetry);
    expect(rec?.level).toBe("warn");
    expect(rec?.fields).toMatchObject({ targetHost: "example.com" });
  });
});
