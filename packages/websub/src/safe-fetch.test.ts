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

  it("re-validates a redirect to a private host and reports the SSRF reason", async () => {
    const doFetch = vi.fn<FetchLike>(async (url) =>
      url === "https://public.example/"
        ? new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          })
        : new Response("should not reach"),
    );
    await expect(
      safeFetch(doFetch, "https://public.example/", { method: "GET" }),
    ).rejects.toMatchObject({ reason: "blocked_host" });
    // The inward bounce must be blocked before the second hop is fetched.
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("throws too_many_redirects past the cap", async () => {
    const doFetch: FetchLike = vi.fn(async (url) => {
      const next = new URL(url);
      next.pathname = `${next.pathname}x`;
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
        { maxRedirects: 2 },
      ),
    ).rejects.toMatchObject({ reason: "too_many_redirects" });
  });

  it("returns a redirect response that lacks a Location header", async () => {
    const doFetch: FetchLike = vi.fn(
      async () => new Response(null, { status: 302 }),
    );
    const { response, url } = await safeFetch(doFetch, "https://example.com/", {
      method: "GET",
    });
    expect(response.status).toBe(302);
    expect(url).toBe("https://example.com/");
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("returns a redirect response whose Location is empty", async () => {
    const doFetch: FetchLike = vi.fn(
      async () =>
        new Response(null, { status: 301, headers: { location: "" } }),
    );
    const { response } = await safeFetch(doFetch, "https://example.com/", {
      method: "GET",
    });
    expect(response.status).toBe(301);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("strips credential headers on a cross-origin redirect but keeps them same-origin", async () => {
    const seen: Headers[] = [];
    const doFetch: FetchLike = vi.fn(async (url, init) => {
      seen.push(new Headers(init?.headers as HeadersInit));
      if (url === "https://a.example/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://a.example/same" }, // same origin
        });
      }
      if (url === "https://a.example/same") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.example/cross" }, // cross origin
        });
      }
      return new Response("ok", { status: 200 });
    });
    await safeFetch(doFetch, "https://a.example/", {
      method: "GET",
      headers: {
        authorization: "Bearer secret",
        cookie: "sid=1",
        "x-hub-signature": "sha256=deadbeef",
        accept: "text/html",
      },
    });
    // hop 0 and hop 1 are same-origin: credential headers retained.
    expect(seen[0]?.get("authorization")).toBe("Bearer secret");
    expect(seen[0]?.get("x-hub-signature")).toBe("sha256=deadbeef");
    expect(seen[1]?.get("authorization")).toBe("Bearer secret");
    expect(seen[1]?.get("cookie")).toBe("sid=1");
    expect(seen[1]?.get("x-hub-signature")).toBe("sha256=deadbeef");
    // hop 2 followed a cross-origin redirect: credential headers dropped, but a
    // non-sensitive header is kept.
    expect(seen[2]?.get("authorization")).toBeNull();
    expect(seen[2]?.get("cookie")).toBeNull();
    expect(seen[2]?.get("x-hub-signature")).toBeNull();
    expect(seen[2]?.get("accept")).toBe("text/html");
  });

  it("preserves method and body across a redirect (no GET downgrade)", async () => {
    const seen: { url: string; method?: string; body?: unknown }[] = [];
    const doFetch: FetchLike = vi.fn(async (url, init) => {
      seen.push({ url, method: init?.method, body: init?.body });
      return url === "https://hub.example/in"
        ? new Response(null, {
            status: 308,
            headers: { location: "https://hub.example/in2" },
          })
        : new Response(null, { status: 200 });
    });
    await safeFetch(doFetch, "https://hub.example/in", {
      method: "POST",
      body: "hub.mode=publish",
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.method).toBe("POST");
    expect(seen[1]?.body).toBe("hub.mode=publish");
  });

  it("logs and counts an SSRF block via injected logger/metrics", async () => {
    const warn = vi.fn();
    const count = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const metrics = { count, gauge: vi.fn(), timing: vi.fn() };
    const doFetch: FetchLike = vi.fn();
    await expect(
      safeFetch(
        doFetch,
        "http://127.0.0.1/secret",
        { method: "GET" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { logger: logger as any, metrics: metrics as any },
      ),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "blocked_host" }),
    );
    expect(count).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "blocked_host" }),
    );
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
