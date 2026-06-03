import { describe, it, expect, vi } from "vitest";
import {
  assertPublicUrl,
  isPrivateOrReservedHost,
  safeFetch,
  SsrfError,
} from "./safe-fetch";
import type { FetchLike } from "./fetch";

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

  it("blocks IPv4-mapped IPv6 addresses pointing at private space", () => {
    expect(isPrivateOrReservedHost("[::ffff:127.0.0.1]")).toBe(true);
    expect(isPrivateOrReservedHost("[::ffff:169.254.169.254]")).toBe(true);
    expect(isPrivateOrReservedHost("[::ffff:8.8.8.8]")).toBe(false);
  });

  it("blocks non-public hostnames", () => {
    expect(isPrivateOrReservedHost("localhost")).toBe(true);
    expect(isPrivateOrReservedHost("foo.localhost")).toBe(true);
    expect(isPrivateOrReservedHost("db.internal")).toBe(true);
    expect(isPrivateOrReservedHost("printer.local")).toBe(true);
    expect(isPrivateOrReservedHost("")).toBe(true);
  });

  it("allows ordinary public hosts", () => {
    expect(isPrivateOrReservedHost("example.com")).toBe(false);
    expect(isPrivateOrReservedHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedHost("172.32.0.1")).toBe(false); // just above 172.16/12
    expect(isPrivateOrReservedHost("[2606:4700:4700::1111]")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("returns the parsed URL for a public http(s) URL", () => {
    expect(assertPublicUrl("https://example.com/x").host).toBe("example.com");
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(SsrfError);
    expect(() => assertPublicUrl("javascript:alert(1)")).toThrow(SsrfError);
  });

  it("rejects a private host", () => {
    expect(() => assertPublicUrl("http://169.254.169.254/latest")).toThrow(
      SsrfError,
    );
    expect(() => assertPublicUrl("http://127.0.0.1:8080/")).toThrow(SsrfError);
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
      {
        method: "GET",
      },
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

  it("rejects a blocked initial host", async () => {
    const doFetch: FetchLike = vi.fn(async () => new Response("ok"));
    await expect(
      safeFetch(doFetch, "http://169.254.169.254/latest", { method: "GET" }),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(doFetch).not.toHaveBeenCalled();
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
        ? new Response(null, {
            status: 301,
            headers: { location: "/moved" },
          })
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
        {
          maxRedirects: 3,
        },
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
});
