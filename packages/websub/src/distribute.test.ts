import { describe, it, expect, vi } from "vitest";
import {
  contentSignature,
  buildLinkHeader,
  fetchTopicContent,
  deliverToSubscriber,
  type TopicContent,
} from "./distribute.js";
import type { Subscription } from "./store.js";
import type { FetchLike } from "@dwk/safe-fetch";

const encoder = new TextEncoder();

describe("contentSignature", () => {
  it("computes sha256=<hex> HMAC matching a known vector", async () => {
    // HMAC-SHA256(key="key", msg="The quick brown fox jumps over the lazy dog")
    const sig = await contentSignature(
      "key",
      encoder.encode("The quick brown fox jumps over the lazy dog"),
    );
    expect(sig).toBe(
      "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("changes when the secret changes", async () => {
    const body = encoder.encode("hello");
    expect(await contentSignature("a", body)).not.toBe(
      await contentSignature("b", body),
    );
  });

  it("emits sha1=<hex> with a correct HMAC-SHA1 (WebSub §8 legacy interop)", async () => {
    // HMAC-SHA1(key="key", msg="The quick brown fox jumps over the lazy dog")
    const sig = await contentSignature(
      "key",
      encoder.encode("The quick brown fox jumps over the lazy dog"),
      "sha1",
    );
    expect(sig).toBe("sha1=de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9");
  });

  it("prefixes the header with the configured method name verbatim", async () => {
    const body = encoder.encode("hi");
    expect(await contentSignature("k", body, "sha384")).toMatch(/^sha384=/);
    expect(await contentSignature("k", body, "sha512")).toMatch(/^sha512=/);
    // The default method stays sha256.
    expect(await contentSignature("k", body)).toMatch(/^sha256=/);
  });
});

describe("buildLinkHeader", () => {
  it("advertises hub and self", () => {
    expect(
      buildLinkHeader("https://hub.example", "https://example.com/feed"),
    ).toBe(
      '<https://hub.example>; rel="hub", <https://example.com/feed>; rel="self"',
    );
  });
});

const sub = (overrides: Partial<Subscription> = {}): Subscription => ({
  callback: "https://sub.example/cb",
  topic: "https://example.com/feed",
  secret: null,
  leaseSeconds: 600,
  expiresAt: Date.now() + 600_000,
  createdAt: Date.now(),
  ...overrides,
});

const content: TopicContent = {
  body: encoder.encode("<feed>updated</feed>"),
  contentType: "application/atom+xml",
};

describe("fetchTopicContent", () => {
  it("returns kind:ok with body and content-type on 2xx", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response("<feed/>", {
          status: 200,
          headers: { "content-type": "application/atom+xml" },
        }),
    );
    const result = await fetchTopicContent("https://example.com/feed", {
      fetch: fetchImpl,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.content.contentType).toBe("application/atom+xml");
    expect(new TextDecoder().decode(result.content.body)).toBe("<feed/>");
  });

  it("returns kind:retry on a non-2xx topic", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () => new Response("", { status: 500 }),
    );
    expect(
      (
        await fetchTopicContent("https://example.com/feed", {
          fetch: fetchImpl,
        })
      ).kind,
    ).toBe("retry");
  });

  it("returns kind:retry when the topic fetch throws", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error("network");
    });
    expect(
      (
        await fetchTopicContent("https://example.com/feed", {
          fetch: fetchImpl,
        })
      ).kind,
    ).toBe("retry");
  });

  // A byte-array body keeps the Response from auto-setting a `text/plain`
  // Content-Type, simulating a topic server that declares none.
  const noContentType = () =>
    new Response(encoder.encode("<feed/>"), { status: 200 });

  it("returns kind:drop (permanent refusal) when Content-Type is absent and no fallback is set", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => noContentType());
    expect(
      (
        await fetchTopicContent("https://example.com/feed", {
          fetch: fetchImpl,
        })
      ).kind,
    ).toBe("drop");
  });

  it("uses defaultContentType when the topic omits Content-Type", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => noContentType());
    const result = await fetchTopicContent("https://example.com/feed", {
      fetch: fetchImpl,
      defaultContentType: "application/atom+xml",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.content.contentType).toBe("application/atom+xml");
    expect(new TextDecoder().decode(result.content.body)).toBe("<feed/>");
  });

  it("prefers the topic's Content-Type over the configured fallback", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/feed+json" },
        }),
    );
    const result = await fetchTopicContent("https://example.com/feed", {
      fetch: fetchImpl,
      defaultContentType: "application/atom+xml",
    });
    expect(result.kind === "ok" && result.content.contentType).toBe(
      "application/feed+json",
    );
  });
});

describe("deliverToSubscriber", () => {
  it("POSTs the body with content-type and Link, no signature without a secret", async () => {
    let seen: { init?: RequestInit } = {};
    const fetchImpl: FetchLike = vi.fn(async (_input, init) => {
      seen = { init };
      return new Response(null, { status: 204 });
    });
    const result = await deliverToSubscriber(
      sub(),
      content,
      "https://hub.example",
      { fetch: fetchImpl },
    );
    expect(result).toEqual({
      callback: "https://sub.example/cb",
      delivered: true,
      status: 204,
    });
    const headers = new Headers(seen.init?.headers as HeadersInit);
    expect(headers.get("content-type")).toBe("application/atom+xml");
    expect(headers.get("link")).toContain('rel="hub"');
    expect(headers.has("x-hub-signature")).toBe(false);
  });

  it("signs the body when the subscription has a secret", async () => {
    let seen: { init?: RequestInit } = {};
    const fetchImpl: FetchLike = vi.fn(async (_input, init) => {
      seen = { init };
      return new Response(null, { status: 200 });
    });
    await deliverToSubscriber(
      sub({ secret: "topsecret" }),
      content,
      "https://hub.example",
      { fetch: fetchImpl },
    );
    const headers = new Headers(seen.init?.headers as HeadersInit);
    expect(headers.get("x-hub-signature")).toBe(
      await contentSignature("topsecret", content.body),
    );
  });

  it("signs with the configured signatureAlgorithm when set", async () => {
    let seen: { init?: RequestInit } = {};
    const fetchImpl: FetchLike = vi.fn(async (_input, init) => {
      seen = { init };
      return new Response(null, { status: 200 });
    });
    await deliverToSubscriber(
      sub({ secret: "topsecret" }),
      content,
      "https://hub.example",
      { fetch: fetchImpl, signatureAlgorithm: "sha1" },
    );
    const headers = new Headers(seen.init?.headers as HeadersInit);
    expect(headers.get("x-hub-signature")).toBe(
      await contentSignature("topsecret", content.body, "sha1"),
    );
    expect(headers.get("x-hub-signature")).toMatch(/^sha1=/);
  });

  it("reports delivered:false on a failed POST", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error("refused");
    });
    const result = await deliverToSubscriber(
      sub(),
      content,
      "https://hub.example",
      { fetch: fetchImpl },
    );
    expect(result).toEqual({
      callback: "https://sub.example/cb",
      delivered: false,
      status: 0,
    });
  });

  it("does not POST to a private callback host (SSRF)", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () => new Response(null, { status: 200 }),
    );
    const result = await deliverToSubscriber(
      sub({ callback: "http://169.254.169.254/cb" }),
      content,
      "https://hub.example",
      { fetch: fetchImpl },
    );
    expect(result.delivered).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
