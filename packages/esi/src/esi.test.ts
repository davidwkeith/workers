import { describe, expect, it, vi } from "vitest";
import { processEsi } from "./esi.js";
import type { FetchLike } from "@dwk/safe-fetch";

describe("processEsi", () => {
  it("splices resolved fragments into a text/html response", async () => {
    const fetchFn: FetchLike = async () => new Response("<b>fragment</b>");
    const response = new Response(
      '<html><body><esi:include src="https://example.com/frag"/></body></html>',
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );

    const result = processEsi(response, { fetch: fetchFn });
    const text = await result.text();
    expect(text).toBe("<html><body><b>fragment</b></body></html>");
  });

  it("passes a non-textual content type through untouched with no fetch attempted", async () => {
    const fetchFn = vi.fn(async () => new Response("should not be called"));
    const original = new Response('{"esi":"<esi:include src=\\"x\\"/>"}', {
      headers: { "content-type": "application/json" },
    });

    const result = processEsi(original, { fetch: fetchFn as FetchLike });
    expect(result).toBe(original);
    expect(await result.text()).toBe('{"esi":"<esi:include src=\\"x\\"/>"}');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("passes an image content type through untouched with no fetch attempted", async () => {
    const fetchFn = vi.fn(async () => new Response("should not be called"));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const original = new Response(bytes, {
      headers: { "content-type": "image/png" },
    });

    const result = processEsi(original, { fetch: fetchFn as FetchLike });
    expect(result).toBe(original);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("is a byte-for-byte no-op on plain text with no ESI markup", async () => {
    const original = new Response("just plain text, nothing special", {
      headers: { "content-type": "text/plain" },
    });
    const result = processEsi(original);
    expect(await result.text()).toBe("just plain text, nothing special");
  });

  it("drops Content-Length but preserves other headers verbatim, e.g. cache-control", async () => {
    const original = new Response("<p>hi</p>", {
      status: 200,
      headers: {
        "content-type": "text/html",
        "content-length": "9",
        "cache-control": "public, max-age=3600",
        "x-custom": "value",
      },
    });

    const result = processEsi(original);
    expect(result.headers.has("content-length")).toBe(false);
    expect(result.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(result.headers.get("x-custom")).toBe("value");
    expect(result.status).toBe(200);
  });
});
