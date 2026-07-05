import { describe, expect, it, vi } from "vitest";

import { discoverFeed, fetchFeed } from "./discovery.js";
import type { FetchLike } from "@dwk/safe-fetch";

const JSON_FEED = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  items: [{ id: "1", url: "https://blog.example/1", title: "One" }],
});

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>A</title><link href="https://blog.example/a"/><id>a</id></entry>
</feed>`;

function jsonResponse(
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/feed+json", ...headers },
  });
}

describe("discoverFeed", () => {
  it("parses a direct JSON feed", async () => {
    const doFetch: FetchLike = vi.fn(async () => jsonResponse(JSON_FEED));
    const result = await discoverFeed("https://blog.example/feed.json", {
      fetch: doFetch,
    });
    expect(result?.feedUrl).toBe("https://blog.example/feed.json");
    expect(result?.entries).toHaveLength(1);
  });

  it("parses a direct Atom feed sniffed from its body", async () => {
    const doFetch: FetchLike = vi.fn(
      async () =>
        new Response(ATOM, {
          status: 200,
          headers: { "content-type": "text/xml" },
        }),
    );
    const result = await discoverFeed("https://blog.example/atom", {
      fetch: doFetch,
    });
    expect(result?.entries).toHaveLength(1);
  });

  it("follows a declared alternate feed link from an HTML page", async () => {
    const html = `<html><head>
      <link rel="alternate" type="application/feed+json" href="/feed.json"/>
    </head><body></body></html>`;
    const doFetch: FetchLike = vi.fn(async (url: string) => {
      if (url.endsWith("/feed.json")) return jsonResponse(JSON_FEED);
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    const result = await discoverFeed("https://blog.example/", {
      fetch: doFetch,
    });
    expect(result?.feedUrl).toBe("https://blog.example/feed.json");
    expect(result?.entries).toHaveLength(1);
  });

  it("falls back to h-feed when an HTML page declares no feed link", async () => {
    const html = `<html><body><div class="h-entry">
      <a class="u-url" href="/p/1"></a><h1 class="p-name">Note</h1>
    </div></body></html>`;
    const doFetch: FetchLike = vi.fn(
      async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const result = await discoverFeed("https://blog.example/", {
      fetch: doFetch,
    });
    expect(result?.feedUrl).toBe("https://blog.example/");
    expect(result?.entries[0]?.name).toBe("Note");
  });

  it("returns null when the target is unreachable or has no feed", async () => {
    const reject: FetchLike = vi.fn(async () => {
      throw new Error("network");
    });
    expect(
      await discoverFeed("https://blog.example/", { fetch: reject }),
    ).toBeNull();

    const empty: FetchLike = vi.fn(
      async () =>
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    expect(
      await discoverFeed("https://blog.example/", { fetch: empty }),
    ).toBeNull();
  });

  it("returns null for a blocked (SSRF) host", async () => {
    const doFetch: FetchLike = vi.fn(async () => jsonResponse(JSON_FEED));
    expect(
      await discoverFeed("http://127.0.0.1/feed", { fetch: doFetch }),
    ).toBeNull();
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("fetchFeed", () => {
  it("sends conditional headers and reports 304", async () => {
    const doFetch: FetchLike = vi.fn(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("if-none-match")).toBe('"abc"');
      expect(headers.get("if-modified-since")).toBe(
        "Mon, 01 Jan 2026 00:00:00 GMT",
      );
      return new Response(null, { status: 304 });
    });
    const result = await fetchFeed(
      "https://blog.example/feed.json",
      { fetch: doFetch },
      { etag: '"abc"', lastModified: "Mon, 01 Jan 2026 00:00:00 GMT" },
    );
    expect(result?.notModified).toBe(true);
    expect(result?.entries).toEqual([]);
  });

  it("parses entries and surfaces validators on a 200", async () => {
    const doFetch: FetchLike = vi.fn(async () =>
      jsonResponse(JSON_FEED, { etag: '"v2"', "last-modified": "later" }),
    );
    const result = await fetchFeed("https://blog.example/feed.json", {
      fetch: doFetch,
    });
    expect(result?.notModified).toBe(false);
    expect(result?.entries).toHaveLength(1);
    expect(result?.etag).toBe('"v2"');
    expect(result?.lastModified).toBe("later");
  });

  it("returns null on a non-2xx response", async () => {
    const doFetch: FetchLike = vi.fn(
      async () => new Response("nope", { status: 500 }),
    );
    expect(
      await fetchFeed("https://blog.example/feed.json", { fetch: doFetch }),
    ).toBeNull();
  });

  it("parses an h-feed when the feed URL serves HTML", async () => {
    const html = `<div class="h-entry"><a class="u-url" href="/x"></a><p class="p-name">X</p></div>`;
    const doFetch: FetchLike = vi.fn(
      async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const result = await fetchFeed("https://blog.example/notes", {
      fetch: doFetch,
    });
    expect(result?.entries[0]?.name).toBe("X");
  });
});
