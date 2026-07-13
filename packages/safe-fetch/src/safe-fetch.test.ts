import { describe, it, expect, vi } from "vitest";
import {
  assertPublicUrl,
  isPrivateOrReservedHost,
  SsrfError,
  safeFetch,
  type FetchLike,
} from "./safe-fetch.js";

describe("isPrivateOrReservedHost", () => {
  it("blocks loopback addresses", () => {
    expect(isPrivateOrReservedHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("127.255.255.254")).toBe(true);
    expect(isPrivateOrReservedHost("[::1]")).toBe(true);
    expect(isPrivateOrReservedHost("::1")).toBe(true);
  });

  it("blocks the link-local / cloud metadata range", () => {
    expect(isPrivateOrReservedHost("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedHost("169.254.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("[fe80::1]")).toBe(true);
  });

  it("blocks RFC 1918 private ranges", () => {
    expect(isPrivateOrReservedHost("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("172.31.255.255")).toBe(true);
    expect(isPrivateOrReservedHost("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedHost("[fc00::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[fd12:3456::1]")).toBe(true);
  });

  it("blocks 0.0.0.0, CGNAT, benchmark, multicast and reserved", () => {
    expect(isPrivateOrReservedHost("0.0.0.0")).toBe(true);
    expect(isPrivateOrReservedHost("100.64.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("198.18.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("224.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("255.255.255.255")).toBe(true);
  });

  it("blocks the IPv4 documentation (TEST-NET) ranges", () => {
    expect(isPrivateOrReservedHost("192.0.2.1")).toBe(true);
    expect(isPrivateOrReservedHost("198.51.100.1")).toBe(true);
    expect(isPrivateOrReservedHost("203.0.113.1")).toBe(true);
  });

  it("blocks IPv6 addresses that embed a private IPv4", () => {
    expect(isPrivateOrReservedHost("[::ffff:127.0.0.1]")).toBe(true);
    expect(isPrivateOrReservedHost("[::ffff:169.254.169.254]")).toBe(true);
    expect(isPrivateOrReservedHost("[::ffff:8.8.8.8]")).toBe(false);
    expect(isPrivateOrReservedHost("[::127.0.0.1]")).toBe(true);
    expect(isPrivateOrReservedHost("[::169.254.169.254]")).toBe(true);
    expect(isPrivateOrReservedHost("[64:ff9b::127.0.0.1]")).toBe(true);
    expect(isPrivateOrReservedHost("[64:ff9b::169.254.169.254]")).toBe(true);
  });

  it("blocks site-local, multicast, and documentation IPv6", () => {
    expect(isPrivateOrReservedHost("[fec0::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[ff02::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[2001:db8::1]")).toBe(true);
  });

  it("blocks non-public hostnames", () => {
    expect(isPrivateOrReservedHost("localhost")).toBe(true);
    expect(isPrivateOrReservedHost("foo.localhost")).toBe(true);
    expect(isPrivateOrReservedHost("db.internal")).toBe(true);
    expect(isPrivateOrReservedHost("printer.local")).toBe(true);
    expect(isPrivateOrReservedHost("")).toBe(true);
  });

  it("blocks .onion hosts (RFC 7686 — unreachable from Workers)", () => {
    expect(
      isPrivateOrReservedHost(
        "duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion",
      ),
    ).toBe(true);
    expect(isPrivateOrReservedHost("sub.example.ONION")).toBe(true);
    expect(isPrivateOrReservedHost("example.onion.")).toBe(true);
    expect(isPrivateOrReservedHost("onion")).toBe(true);
    expect(isPrivateOrReservedHost("onion.example.com")).toBe(false);
  });

  it("blocks names with a trailing dot (FQDN form)", () => {
    expect(isPrivateOrReservedHost("localhost.")).toBe(true);
    expect(isPrivateOrReservedHost("db.internal.")).toBe(true);
  });

  it("allows ordinary public hosts", () => {
    expect(isPrivateOrReservedHost("example.com")).toBe(false);
    expect(isPrivateOrReservedHost("example.com.")).toBe(false);
    expect(isPrivateOrReservedHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedHost("172.32.0.1")).toBe(false);
    expect(isPrivateOrReservedHost("[2606:4700:4700::1111]")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("returns the parsed URL for a public http(s) URL by default", () => {
    expect(assertPublicUrl("https://example.com/x").host).toBe("example.com");
    expect(assertPublicUrl("http://example.com/x").host).toBe("example.com");
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(SsrfError);
    expect(() => assertPublicUrl("javascript:alert(1)")).toThrow(SsrfError);
  });

  it("restricts to allowedSchemes when given", () => {
    expect(() =>
      assertPublicUrl("http://example.com/x", { allowedSchemes: ["https:"] }),
    ).toThrow(SsrfError);
    expect(
      assertPublicUrl("https://example.com/x", { allowedSchemes: ["https:"] })
        .protocol,
    ).toBe("https:");
  });

  it("rejects a private host", () => {
    expect(() => assertPublicUrl("http://169.254.169.254/latest")).toThrow(
      SsrfError,
    );
    expect(() => assertPublicUrl("http://127.0.0.1:8080/")).toThrow(SsrfError);
  });

  it("rejects a .onion URL as a blocked host", () => {
    try {
      assertPublicUrl("http://example.onion/inbox");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SsrfError);
      expect((error as SsrfError).reason).toBe("blocked_host");
    }
  });

  it("rejects an unparseable URL", () => {
    expect(() => assertPublicUrl("not a url")).toThrow(SsrfError);
  });
});

describe("safeFetch", () => {
  it("fetches a public URL and reports the final URL", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("ok"));
    const { response, url } = await safeFetch(
      doFetch,
      "https://example.com/a",
      { method: "GET" },
    );
    expect(await response.text()).toBe("ok");
    expect(url).toBe("https://example.com/a");
  });

  it("sends redirect:manual and a timeout signal to the underlying fetch", async () => {
    const doFetch = vi.fn<FetchLike>(async () => new Response("ok"));
    await safeFetch(doFetch, "https://example.com/", { method: "GET" });
    const init = doFetch.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("combines a caller-supplied signal with its own timeout", async () => {
    const doFetch = vi.fn<FetchLike>(async () => new Response("ok"));
    const controller = new AbortController();
    await safeFetch(doFetch, "https://example.com/", {
      method: "GET",
      signal: controller.signal,
    });
    const init = doFetch.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal).not.toBe(controller.signal);
  });

  it("rejects a blocked initial host", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("ok"));
    await expect(
      safeFetch(doFetch, "http://169.254.169.254/latest", { method: "GET" }),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("respects a restricted allowedSchemes option", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("ok"));
    await expect(
      safeFetch(
        doFetch,
        "http://example.com/",
        { method: "GET" },
        { allowedSchemes: ["https:"] },
      ),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("follows a redirect to another public host, re-validating it", async () => {
    const doFetch = vi.fn<FetchLike>(async (url) => {
      if (url === "https://a.example/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.example/final" },
        });
      }
      return new Response("landed");
    });
    const { response, url } = await safeFetch(doFetch, "https://a.example/", {
      method: "GET",
    });
    expect(await response.text()).toBe("landed");
    expect(url).toBe("https://b.example/final");
  });

  it("blocks a redirect that points at an internal host", async () => {
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
    ).rejects.toBeInstanceOf(SsrfError);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("resolves a relative redirect against the current URL", async () => {
    const doFetch = vi.fn<FetchLike>(async (url) =>
      url === "https://a.example/start"
        ? new Response(null, { status: 301, headers: { location: "/moved" } })
        : new Response("landed"),
    );
    const { url } = await safeFetch(doFetch, "https://a.example/start", {
      method: "GET",
    });
    expect(url).toBe("https://a.example/moved");
  });

  it("gives up after too many redirects", async () => {
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
        { maxRedirects: 3 },
      ),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("returns a redirect response that lacks a Location header", async () => {
    const doFetch: FetchLike = vi.fn(
      async () => new Response(null, { status: 302 }),
    );
    const { response } = await safeFetch(doFetch, "https://example.com/", {
      method: "GET",
    });
    expect(response.status).toBe(302);
  });

  it("strips credential headers on a cross-origin redirect but keeps them same-origin", async () => {
    const seen: Headers[] = [];
    const doFetch: FetchLike = vi.fn(async (url, init) => {
      seen.push(new Headers(init?.headers as HeadersInit));
      if (url === "https://a.example/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://a.example/same" },
        });
      }
      if (url === "https://a.example/same") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.example/cross" },
        });
      }
      return new Response("ok");
    });
    await safeFetch(doFetch, "https://a.example/", {
      method: "GET",
      headers: { authorization: "Bearer secret", accept: "text/html" },
    });
    expect(seen[0]?.get("authorization")).toBe("Bearer secret");
    expect(seen[1]?.get("authorization")).toBe("Bearer secret");
    expect(seen[2]?.get("authorization")).toBeNull();
    expect(seen[2]?.get("accept")).toBe("text/html");
  });

  it("strips extra stripHeadersCrossOrigin headers on a cross-origin redirect", async () => {
    const seen: Headers[] = [];
    const doFetch: FetchLike = vi.fn(async (url, init) => {
      seen.push(new Headers(init?.headers as HeadersInit));
      return url === "https://a.example/"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://b.example/cross" },
          })
        : new Response("ok");
    });
    await safeFetch(
      doFetch,
      "https://a.example/",
      { method: "GET", headers: { "x-hub-signature": "abc" } },
      { stripHeadersCrossOrigin: ["x-hub-signature"] },
    );
    expect(seen[1]?.get("x-hub-signature")).toBeNull();
  });

  it("preserves method and body across a redirect (no GET downgrade)", async () => {
    const seen: { url: string; method?: string; body?: unknown }[] = [];
    const doFetch: FetchLike = vi.fn(async (url, init) => {
      seen.push({ url, method: init?.method, body: init?.body });
      return url === "https://wm.example/in"
        ? new Response(null, {
            status: 307,
            headers: { location: "https://wm.example/in2" },
          })
        : new Response(null, { status: 202 });
    });
    await safeFetch(doFetch, "https://wm.example/in", {
      method: "POST",
      body: "source=x&target=y",
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.method).toBe("POST");
    expect(seen[1]?.body).toBe("source=x&target=y");
  });

  it("logs and counts under the caller-supplied logEvent on an SSRF block", async () => {
    const logger = {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    const metrics = { count: vi.fn(), observe: vi.fn() };
    const doFetch: FetchLike = vi.fn(async () => new Response("ok"));
    await expect(
      safeFetch(
        doFetch,
        "http://127.0.0.1/",
        { method: "GET" },
        { logger, metrics, logEvent: "custom.ssrf.blocked" },
      ),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(logger.warn).toHaveBeenCalledWith(
      "custom.ssrf.blocked",
      expect.objectContaining({ reason: "blocked_host" }),
    );
    expect(metrics.count).toHaveBeenCalledWith(
      "custom.ssrf.blocked",
      expect.objectContaining({ reason: "blocked_host" }),
    );
  });
});
