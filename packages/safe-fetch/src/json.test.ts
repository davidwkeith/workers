import { describe, it, expect, vi } from "vitest";
import { safeFetchJson } from "./json.js";
import { SsrfError, type FetchLike } from "./safe-fetch.js";

describe("safeFetchJson", () => {
  it("fetches and parses a JSON body", async () => {
    const doFetch: FetchLike = vi.fn(
      async () => new Response(JSON.stringify({ hello: "world" })),
    );
    const result = await safeFetchJson(doFetch, "https://example.com/data");
    expect(result).toEqual({ hello: "world" });
  });

  it("throws on a non-ok response", async () => {
    const doFetch: FetchLike = vi.fn(
      async () => new Response("nope", { status: 500 }),
    );
    await expect(
      safeFetchJson(doFetch, "https://example.com/data"),
    ).rejects.toThrow(/status/i);
  });

  it("throws when the body exceeds maxBodyBytes", async () => {
    const doFetch: FetchLike = vi.fn(
      async () => new Response(JSON.stringify({ big: "x".repeat(2000) })),
    );
    await expect(
      safeFetchJson(doFetch, "https://example.com/data", undefined, {
        maxBodyBytes: 10,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("throws on invalid JSON", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("not json"));
    await expect(
      safeFetchJson(doFetch, "https://example.com/data"),
    ).rejects.toThrow();
  });

  it("throws when the content-type is clearly not JSON (e.g. an HTML error page)", async () => {
    const doFetch: FetchLike = vi.fn(
      async () =>
        new Response("<html>not json, honest</html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    await expect(
      safeFetchJson(doFetch, "https://example.com/data"),
    ).rejects.toThrow(/content-type/i);
  });

  it("accepts a missing content-type and JSON-ish variants (+json, text/plain)", async () => {
    for (const contentType of [
      null,
      "application/json",
      "application/did+json",
      "application/ld+json; charset=utf-8",
      "text/plain",
    ]) {
      const headers = new Headers();
      if (contentType !== null) {
        headers.set("content-type", contentType);
      }
      const doFetch: FetchLike = vi.fn(
        async () => new Response(JSON.stringify({ ok: true }), { headers }),
      );
      await expect(
        safeFetchJson(doFetch, "https://example.com/data"),
      ).resolves.toEqual({ ok: true });
    }
  });

  it("propagates SsrfError for a blocked host", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("{}"));
    await expect(
      safeFetchJson(doFetch, "http://169.254.169.254/data"),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("respects allowedSchemes", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("{}"));
    await expect(
      safeFetchJson(doFetch, "http://example.com/data", undefined, {
        allowedSchemes: ["https:"],
      }),
    ).rejects.toBeInstanceOf(SsrfError);
  });
});
