import { describe, it, expect, vi } from "vitest";
import { sendWebmention, sendWebmentions } from "./sender";
import type { FetchLike } from "./fetch";

const source = "https://me.example/post";
const target = "https://target.example/article";

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
