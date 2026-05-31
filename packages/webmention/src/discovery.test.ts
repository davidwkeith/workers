import { describe, it, expect, vi } from "vitest";
import { discoverEndpoint, findWebmentionEndpoint } from "./discovery";
import type { FetchLike } from "./fetch";

const doc = "https://target.example/post";

describe("findWebmentionEndpoint", () => {
  it("prefers the HTTP Link header over HTML", () => {
    const endpoint = findWebmentionEndpoint(
      '<https://target.example/wm>; rel="webmention"',
      '<link rel="webmention" href="/html-wm">',
      doc,
    );
    expect(endpoint).toBe("https://target.example/wm");
  });

  it("resolves a relative Link header endpoint against the document URL", () => {
    const endpoint = findWebmentionEndpoint('</wm>; rel="webmention"', "", doc);
    expect(endpoint).toBe("https://target.example/wm");
  });

  it("falls back to the first <link rel=webmention> in document order", () => {
    const endpoint = findWebmentionEndpoint(
      null,
      '<link rel="webmention" href="https://target.example/a">' +
        '<link rel="webmention" href="https://target.example/b">',
      doc,
    );
    expect(endpoint).toBe("https://target.example/a");
  });

  it("accepts <a rel=webmention> and multi-token rels", () => {
    const endpoint = findWebmentionEndpoint(
      null,
      '<a href="/mentions" rel="me webmention">wm</a>',
      doc,
    );
    expect(endpoint).toBe("https://target.example/mentions");
  });

  it("accepts the legacy http://webmention.org/ rel", () => {
    const endpoint = findWebmentionEndpoint(
      '<https://target.example/legacy>; rel="http://webmention.org/"',
      "",
      doc,
    );
    expect(endpoint).toBe("https://target.example/legacy");
  });

  it("treats an empty href as the document itself", () => {
    const endpoint = findWebmentionEndpoint(
      null,
      '<link rel="webmention" href="">',
      doc,
    );
    expect(endpoint).toBe(doc);
  });

  it("returns null when no endpoint is advertised", () => {
    expect(findWebmentionEndpoint(null, "<p>nothing</p>", doc)).toBeNull();
  });
});

describe("discoverEndpoint", () => {
  it("discovers from the Link header without reading the body", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      Response.json(
        {},
        {
          headers: {
            link: '<https://target.example/wm>; rel="webmention"',
            "content-type": "text/html",
          },
        },
      ),
    );
    expect(await discoverEndpoint(doc, { fetch: fetchImpl })).toBe(
      "https://target.example/wm",
    );
  });

  it("discovers from HTML when no Link header is present", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response('<link rel="webmention" href="/wm">', {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    expect(await discoverEndpoint(doc, { fetch: fetchImpl })).toBe(
      "https://target.example/wm",
    );
  });

  it("ignores HTML bodies that are not html content-type", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response('<link rel="webmention" href="/wm">', {
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await discoverEndpoint(doc, { fetch: fetchImpl })).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await discoverEndpoint(doc, { fetch: fetchImpl })).toBeNull();
  });
});
