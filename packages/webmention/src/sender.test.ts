import { describe, it, expect, vi } from "vitest";
import {
  sendWebmention,
  sendWebmentions,
  resendForDeletedSource,
} from "./sender.js";
import type { SentLog } from "./sent-log.js";
import type { FetchLike } from "@dwk/safe-fetch";

const source = "https://me.example/post";
const target = "https://target.example/article";

/** In-memory {@link SentLog} for exercising the sender's recording paths. */
function memorySentLog(): SentLog & {
  readonly rows: Map<string, number>;
} {
  const rows = new Map<string, number>();
  return {
    rows,
    async record(src, tgt, sentAt) {
      rows.set(`${src}\n${tgt}`, sentAt);
    },
    async listTargets(src) {
      return [...rows.keys()]
        .filter((key) => key.startsWith(`${src}\n`))
        .map((key) => key.slice(src.length + 1));
    },
    async remove(src, tgt) {
      rows.delete(`${src}\n${tgt}`);
    },
  };
}

/** Fetch fake: `rel=webmention` Link header on GET, `status` on POST. */
function endpointFetch(status: number): FetchLike {
  return vi.fn(async (url, init) =>
    init?.method === "POST"
      ? new Response(null, { status })
      : new Response("", {
          headers: {
            link: `<${new URL("/wm", url).href}>; rel="webmention"`,
            "content-type": "text/html",
          },
        }),
  );
}

describe("sendWebmention", () => {
  it("discovers the endpoint then POSTs source and target", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (init?.method === "POST") {
        return new Response(null, { status: 201 });
      }
      return new Response('<link rel="webmention" href="/wm">', {
        headers: { "content-type": "text/html" },
      });
    });

    const result = await sendWebmention(source, target, { fetch: fetchImpl });

    expect(result).toEqual({
      target,
      endpoint: "https://target.example/wm",
      delivered: true,
      status: 201,
    });
    const post = calls.find((c) => c.init?.method === "POST");
    expect(post?.url).toBe("https://target.example/wm");
    const body = new URLSearchParams(post?.init?.body as string);
    expect(body.get("source")).toBe(source);
    expect(body.get("target")).toBe(target);
  });

  it("skips targets that declare no endpoint", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response("<p>no endpoint</p>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const result = await sendWebmention(source, target, { fetch: fetchImpl });
    expect(result).toEqual({
      target,
      endpoint: null,
      delivered: false,
      status: 0,
    });
  });

  it("refuses to POST a non-http(s) discovered endpoint", async () => {
    const posted: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        posted.push(url);
        return new Response(null, { status: 202 });
      }
      return new Response(
        '<a rel="webmention" href="mailto:wm@target.example">x</a>',
        {
          headers: { "content-type": "text/html" },
        },
      );
    });
    const result = await sendWebmention(source, target, { fetch: fetchImpl });
    expect(result).toEqual({
      target,
      endpoint: null,
      delivered: false,
      status: 0,
    });
    expect(posted).toEqual([]);
  });

  it("reports a non-2xx endpoint as not delivered", async () => {
    const fetchImpl: FetchLike = vi.fn(async (_url, init) =>
      init?.method === "POST"
        ? new Response("bad", { status: 400 })
        : new Response("", {
            headers: {
              link: '<https://target.example/wm>; rel="webmention"',
              "content-type": "text/html",
            },
          }),
    );
    const result = await sendWebmention(source, target, { fetch: fetchImpl });
    expect(result.delivered).toBe(false);
    expect(result.status).toBe(400);
  });
});

describe("sendWebmention — sent log", () => {
  it("records a delivered notification when a sentLog is supplied", async () => {
    const sentLog = memorySentLog();
    await sendWebmention(source, target, {
      fetch: endpointFetch(202),
      sentLog,
    });
    expect(await sentLog.listTargets(source)).toEqual([target]);
  });

  it("does not record a rejected or endpoint-less notification", async () => {
    const sentLog = memorySentLog();
    await sendWebmention(source, target, {
      fetch: endpointFetch(400),
      sentLog,
    });
    const noEndpoint: FetchLike = vi.fn(
      async () =>
        new Response("<p>none</p>", {
          headers: { "content-type": "text/html" },
        }),
    );
    await sendWebmention(source, "https://b.example/", {
      fetch: noEndpoint,
      sentLog,
    });
    expect(await sentLog.listTargets(source)).toEqual([]);
  });

  it("survives a sentLog write failure — the send still reports delivered", async () => {
    const sentLog = memorySentLog();
    sentLog.record = async () => {
      throw new Error("d1 down");
    };
    const result = await sendWebmention(source, target, {
      fetch: endpointFetch(202),
      sentLog,
    });
    expect(result.delivered).toBe(true);
  });
});

describe("resendForDeletedSource", () => {
  it("re-sends to every recorded target and clears accepted rows", async () => {
    const sentLog = memorySentLog();
    await sentLog.record(source, "https://a.example/", 1);
    await sentLog.record(source, "https://b.example/", 2);
    // Another source's row must be untouched by the resend.
    await sentLog.record("https://me.example/other", "https://c.example/", 3);

    const posted: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        posted.push(new URLSearchParams(init.body as string).get("target")!);
        return new Response(null, { status: 202 });
      }
      return new Response("", {
        headers: {
          link: `<${new URL("/wm", url).href}>; rel="webmention"`,
          "content-type": "text/html",
        },
      });
    });

    const results = await resendForDeletedSource(source, {
      fetch: fetchImpl,
      sentLog,
    });
    expect(posted.sort()).toEqual(["https://a.example/", "https://b.example/"]);
    expect(results.every((r) => r.delivered)).toBe(true);
    expect(await sentLog.listTargets(source)).toEqual([]);
    expect(await sentLog.listTargets("https://me.example/other")).toEqual([
      "https://c.example/",
    ]);
  });

  it("clears a target that no longer declares an endpoint", async () => {
    const sentLog = memorySentLog();
    await sentLog.record(source, target, 1);
    const noEndpoint: FetchLike = vi.fn(
      async () =>
        new Response("<p>gone</p>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const results = await resendForDeletedSource(source, {
      fetch: noEndpoint,
      sentLog,
    });
    expect(results).toEqual([
      { target, endpoint: null, delivered: false, status: 0 },
    ]);
    expect(await sentLog.listTargets(source)).toEqual([]);
  });

  it("keeps the row when the endpoint rejects the re-send, for a later retry", async () => {
    const sentLog = memorySentLog();
    await sentLog.record(source, target, 1);
    const results = await resendForDeletedSource(source, {
      fetch: endpointFetch(500),
      sentLog,
    });
    expect(results[0]?.delivered).toBe(false);
    expect(await sentLog.listTargets(source)).toEqual([target]);
  });
});

describe("sendWebmentions", () => {
  it("notifies every target, preserving order", async () => {
    const fetchImpl: FetchLike = vi.fn(async (url, init) =>
      init?.method === "POST"
        ? new Response(null, { status: 202 })
        : new Response("", {
            headers: {
              link: `<${url}wm>; rel="webmention"`,
              "content-type": "text/html",
            },
          }),
    );
    const results = await sendWebmentions(
      source,
      ["https://a.example/", "https://b.example/"],
      { fetch: fetchImpl },
    );
    expect(results.map((r) => r.target)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
    expect(results.every((r) => r.delivered)).toBe(true);
  });
});
