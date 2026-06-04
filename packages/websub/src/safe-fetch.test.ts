import { describe, it, expect, vi } from "vitest";
import {
  safeFetch,
  assertPublicUrl,
  isPrivateOrReservedHost,
  SsrfError,
} from "./safe-fetch";
import type { FetchLike } from "./fetch";

describe("isPrivateOrReservedHost", () => {
  it("flags loopback, private, link-local, and named-internal hosts", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "169.254.169.254",
      "0.0.0.0",
      "localhost",
      "foo.internal",
      "bar.local",
      "[::1]",
      "[fe80::1]",
      "[::ffff:127.0.0.1]",
    ]) {
      expect(isPrivateOrReservedHost(host), host).toBe(true);
    }
  });

  it("allows ordinary public hosts", () => {
    for (const host of ["example.com", "8.8.8.8", "[2606:4700::1111]"]) {
      expect(isPrivateOrReservedHost(host), host).toBe(false);
    }
  });
});

describe("assertPublicUrl", () => {
  it("rejects non-http(s) schemes", () => {
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(SsrfError);
    expect(() => assertPublicUrl("javascript:alert(1)")).toThrow(SsrfError);
  });
  it("rejects a private host", () => {
    expect(() => assertPublicUrl("http://127.0.0.1/x")).toThrow(SsrfError);
  });
  it("accepts a public https URL", () => {
    expect(assertPublicUrl("https://example.com/x").host).toBe("example.com");
  });
});

describe("safeFetch", () => {
  it("blocks a private initial host before fetching", async () => {
    const fetchImpl: FetchLike = vi.fn();
    await expect(
      safeFetch(fetchImpl, "http://169.254.169.254/", { method: "GET" }),
    ).rejects.toThrow(SsrfError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-validates the host on a redirect and blocks an inward bounce", async () => {
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      if (input === "https://public.example/") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/secret" },
        });
      }
      return new Response("should not reach", { status: 200 });
    });
    await expect(
      safeFetch(fetchImpl, "https://public.example/", { method: "GET" }),
    ).rejects.toThrow(SsrfError);
  });

  it("returns the final response after a permitted redirect", async () => {
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      if (input === "https://a.example/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.example/" },
        });
      }
      return new Response("ok", { status: 200 });
    });
    const { response, url } = await safeFetch(fetchImpl, "https://a.example/", {
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect(url).toBe("https://b.example/");
  });

  it("honors a caller-provided abort signal alongside the timeout", async () => {
    // The fetch observes the merged signal; abort the caller's signal and it
    // should already be aborted by the time the underlying fetch is called.
    const controller = new AbortController();
    controller.abort();
    const fetchImpl: FetchLike = vi.fn(async (_input, init) => {
      if (init?.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      return new Response("ok", { status: 200 });
    });
    await expect(
      safeFetch(fetchImpl, "https://a.example/", {
        method: "GET",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });
});
