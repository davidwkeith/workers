import { describe, it, expect, vi } from "vitest";
import {
  assertPublicHttpsUrl,
  isPrivateOrReservedHost,
  readBodyCapped,
  safeFetchJson,
  SsrfError,
  type FetchLike,
} from "./safe-fetch.js";

describe("isPrivateOrReservedHost", () => {
  it("blocks loopback, link-local, and RFC 1918 ranges", () => {
    expect(isPrivateOrReservedHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedHost("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedHost("[::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[fe80::1]")).toBe(true);
  });

  it("blocks non-public hostnames", () => {
    expect(isPrivateOrReservedHost("localhost")).toBe(true);
    expect(isPrivateOrReservedHost("db.internal")).toBe(true);
    expect(isPrivateOrReservedHost("printer.local")).toBe(true);
    expect(isPrivateOrReservedHost("")).toBe(true);
  });

  it("allows ordinary public hosts", () => {
    expect(isPrivateOrReservedHost("example.com")).toBe(false);
    expect(isPrivateOrReservedHost("8.8.8.8")).toBe(false);
  });
});

describe("assertPublicHttpsUrl", () => {
  it("rejects non-https schemes", () => {
    expect(() => assertPublicHttpsUrl("http://example.com")).toThrow(SsrfError);
  });

  it("rejects an unparseable URL", () => {
    expect(() => assertPublicHttpsUrl("not a url")).toThrow(SsrfError);
  });

  it("rejects a private host even over https", () => {
    expect(() => assertPublicHttpsUrl("https://169.254.169.254/list")).toThrow(
      SsrfError,
    );
  });

  it("allows a public https URL", () => {
    expect(assertPublicHttpsUrl("https://example.com/list").href).toBe(
      "https://example.com/list",
    );
  });
});

describe("readBodyCapped", () => {
  it("rejects a body over the declared Content-Length cap", async () => {
    const response = new Response("hello world", {
      headers: { "content-length": "1000" },
    });
    expect(await readBodyCapped(response, 10)).toBeNull();
  });

  it("reads a body within the cap", async () => {
    const response = new Response("hi");
    expect(await readBodyCapped(response, 1024)).toBe("hi");
  });

  it("aborts a streamed body that exceeds the cap despite a missing/lying header", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20));
        controller.close();
      },
    });
    expect(await readBodyCapped(new Response(stream), 10)).toBeNull();
  });
});

describe("safeFetchJson", () => {
  it("rejects a private-host URL without ever calling fetch", async () => {
    const doFetch = vi.fn<FetchLike>();
    await expect(
      safeFetchJson("https://169.254.169.254/list", { fetch: doFetch }),
    ).rejects.toThrow(SsrfError);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("fetches, follows a same-origin redirect, and parses JSON", async () => {
    const doFetch = vi.fn<FetchLike>(async (url) => {
      if (url === "https://example.com/list") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com/list2" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await safeFetchJson("https://example.com/list", {
      fetch: doFetch,
    });
    expect(result).toEqual({ ok: true });
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("re-validates the host on redirect, blocking a bounce to a private host", async () => {
    const doFetch = vi.fn<FetchLike>(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/internal" },
      });
    });
    await expect(
      safeFetchJson("https://example.com/list", { fetch: doFetch }),
    ).rejects.toThrow(SsrfError);
  });

  it("throws on a non-ok response", async () => {
    const doFetch = vi.fn<FetchLike>(
      async () => new Response("nope", { status: 500 }),
    );
    await expect(
      safeFetchJson("https://example.com/list", { fetch: doFetch }),
    ).rejects.toThrow("status list fetch failed: 500");
  });

  it("throws when the body exceeds the cap", async () => {
    const doFetch = vi.fn<FetchLike>(
      async () =>
        new Response(JSON.stringify({ padding: "x".repeat(100) }), {
          status: 200,
        }),
    );
    await expect(
      safeFetchJson("https://example.com/list", {
        fetch: doFetch,
        maxBodyBytes: 10,
      }),
    ).rejects.toThrow("status list response too large");
  });
});
