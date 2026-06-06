import { describe, it, expect, vi } from "vitest";
import { discoverEndpoint, findWebmentionEndpoint } from "./discovery";
import type { FetchLike } from "./fetch";

const doc = "https://target.example/post";

describe("findWebmentionEndpoint", () => {
  it("prefers the HTTP Link header over HTML", async () => {
    const endpoint = await findWebmentionEndpoint(
      '<https://target.example/wm>; rel="webmention"',
      '<link rel="webmention" href="/html-wm">',
      doc,
    );
    expect(endpoint).toBe("https://target.example/wm");
  });

  it("resolves a relative Link header endpoint against the document URL", async () => {
    const endpoint = await findWebmentionEndpoint(
      '</wm>; rel="webmention"',
      "",
      doc,
    );
    expect(endpoint).toBe("https://target.example/wm");
  });

  it("falls back to the first <link rel=webmention> in document order", async () => {
    const endpoint = await findWebmentionEndpoint(
      null,
      '<link rel="webmention" href="https://target.example/a">' +
        '<link rel="webmention" href="https://target.example/b">',
      doc,
    );
    expect(endpoint).toBe("https://target.example/a");
  });

  it("accepts <a rel=webmention> and multi-token rels", async () => {
    const endpoint = await findWebmentionEndpoint(
      null,
      '<a href="/mentions" rel="me webmention">wm</a>',
      doc,
    );
    expect(endpoint).toBe("https://target.example/mentions");
  });

  it("accepts the legacy http://webmention.org/ rel", async () => {
    const endpoint = await findWebmentionEndpoint(
      '<https://target.example/legacy>; rel="http://webmention.org/"',
      "",
      doc,
    );
    expect(endpoint).toBe("https://target.example/legacy");
  });

  it("accepts the legacy http://webmention.org/webmention rel", async () => {
    const endpoint = await findWebmentionEndpoint(
      '<https://target.example/legacy>; rel="http://webmention.org/webmention"',
      "",
      doc,
    );
    expect(endpoint).toBe("https://target.example/legacy");
  });

  it("rejects a legacy-rel look-alike host", async () => {
    const endpoint = await findWebmentionEndpoint(
      '<https://target.example/spoof>; rel="http://webmention.org.evil.example/"',
      "",
      doc,
    );
    expect(endpoint).toBeNull();
  });

  it("treats an empty href as the document itself", async () => {
    const endpoint = await findWebmentionEndpoint(
      null,
      '<link rel="webmention" href="">',
      doc,
    );
    expect(endpoint).toBe(doc);
  });

  it("resolves a relative HTML endpoint against a <base href>", async () => {
    const endpoint = await findWebmentionEndpoint(
      null,
      '<base href="https://cdn.example/p/"><link rel="webmention" href="wm">',
      doc,
    );
    expect(endpoint).toBe("https://cdn.example/p/wm");
  });

  it("returns null when no endpoint is advertised", async () => {
    expect(
      await findWebmentionEndpoint(null, "<p>nothing</p>", doc),
    ).toBeNull();
  });

  // webmention.rocks discovery conformance cases.
  it("ignores a false endpoint inside an HTML comment (rocks #13)", async () => {
    const endpoint = await findWebmentionEndpoint(
      null,
      "<!-- <link rel=\"webmention\" href='/false'> -->" +
        '<link rel="webmention" href="/real">',
      doc,
    );
    expect(endpoint).toBe("https://target.example/real");
  });

  it("ignores a non-webmention rel that contains the substring (rocks #12)", async () => {
    const endpoint = await findWebmentionEndpoint(
      null,
      '<link rel="not-webmention" href="/false">' +
        '<link rel="webmention" href="/real">',
      doc,
    );
    expect(endpoint).toBe("https://target.example/real");
  });

  it("skips a rel=webmention tag with no href attribute (rocks #20)", async () => {
    const endpoint = await findWebmentionEndpoint(
      null,
      '<link rel="webmention">' + '<a rel="webmention" href="/real">x</a>',
      doc,
    );
    expect(endpoint).toBe("https://target.example/real");
  });

  it("takes the first endpoint across <a> then <link> in document order (rocks #16)", async () => {
    const endpoint = await findWebmentionEndpoint(
      null,
      '<a rel="webmention" href="/first">x</a>' +
        '<link rel="webmention" href="/second">',
      doc,
    );
    expect(endpoint).toBe("https://target.example/first");
  });

  it("keeps an endpoint with query-string parameters intact (rocks #21)", async () => {
    const endpoint = await findWebmentionEndpoint(
      '<https://target.example/wm?query=1>; rel="webmention"',
      "",
      doc,
    );
    expect(endpoint).toBe("https://target.example/wm?query=1");
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
