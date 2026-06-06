import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "./fetch";
import {
  assertPublicUrl,
  isPrivateOrReservedHost,
  safeFetch,
  SsrfError,
} from "./safe-fetch";

describe("isPrivateOrReservedHost", () => {
  it("blocks private, loopback, link-local, and reserved IPv4", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "192.0.2.5",
    ]) {
      expect(isPrivateOrReservedHost(host)).toBe(true);
    }
  });

  it("blocks loopback and mapped IPv6, and reserved hostnames", () => {
    expect(isPrivateOrReservedHost("[::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[fe80::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[::ffff:127.0.0.1]")).toBe(true);
    expect(isPrivateOrReservedHost("localhost")).toBe(true);
    expect(isPrivateOrReservedHost("db.internal")).toBe(true);
    expect(isPrivateOrReservedHost("printer.local")).toBe(true);
    expect(isPrivateOrReservedHost("")).toBe(true);
  });

  it("allows ordinary public hosts", () => {
    expect(isPrivateOrReservedHost("example.com")).toBe(false);
    expect(isPrivateOrReservedHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedHost("[2606:4700::1]")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("rejects bad URLs, schemes, and blocked hosts", () => {
    expect(() => assertPublicUrl("not a url")).toThrow(SsrfError);
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(/scheme/);
    expect(() => assertPublicUrl("http://127.0.0.1/")).toThrow(/blocked/);
  });

  it("accepts a public https URL", () => {
    expect(assertPublicUrl("https://example.com/feed").host).toBe(
      "example.com",
    );
  });
});

describe("safeFetch", () => {
  it("returns the response for a public URL", async () => {
    const doFetch: FetchLike = vi.fn(
      async () => new Response("ok", { status: 200 }),
    );
    const result = await safeFetch(doFetch, "https://example.com/feed", {
      method: "GET",
    });
    expect(result.response.status).toBe(200);
    expect(result.url).toBe("https://example.com/feed");
  });

  it("follows a redirect, re-validating the new host", async () => {
    const doFetch: FetchLike = vi.fn(async (url: string) => {
      if (url === "https://example.com/feed") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/real" },
        });
      }
      return new Response("body", { status: 200 });
    });
    const result = await safeFetch(doFetch, "https://example.com/feed", {
      method: "GET",
      headers: { authorization: "secret" },
    });
    expect(result.url).toBe("https://cdn.example/real");
    // The cross-origin hop dropped the Authorization header.
    const secondCall = (doFetch as ReturnType<typeof vi.fn>).mock.calls[1];
    const headers = new Headers((secondCall?.[1] as RequestInit).headers);
    expect(headers.get("authorization")).toBeNull();
  });

  it("refuses a redirect to a private host", async () => {
    const doFetch: FetchLike = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/" },
        }),
    );
    await expect(
      safeFetch(doFetch, "https://example.com/feed", { method: "GET" }),
    ).rejects.toThrow(SsrfError);
  });

  it("caps the redirect chain", async () => {
    const doFetch: FetchLike = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/next" },
        }),
    );
    await expect(
      safeFetch(
        doFetch,
        "https://example.com/feed",
        { method: "GET" },
        { maxRedirects: 2 },
      ),
    ).rejects.toThrow(/too many redirects/);
  });
});
