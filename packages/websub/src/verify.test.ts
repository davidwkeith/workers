import { describe, it, expect, vi } from "vitest";
import {
  verifyIntent,
  buildVerificationUrl,
  generateChallenge,
} from "./verify";
import type { FetchLike } from "./fetch";

describe("buildVerificationUrl", () => {
  it("appends hub.* params, preserving existing query", () => {
    const url = new URL(
      buildVerificationUrl("https://sub.example/cb?token=abc", {
        mode: "subscribe",
        topic: "https://example.com/feed",
        challenge: "chal123",
        leaseSeconds: 600,
      }),
    );
    expect(url.searchParams.get("token")).toBe("abc");
    expect(url.searchParams.get("hub.mode")).toBe("subscribe");
    expect(url.searchParams.get("hub.topic")).toBe("https://example.com/feed");
    expect(url.searchParams.get("hub.challenge")).toBe("chal123");
    expect(url.searchParams.get("hub.lease_seconds")).toBe("600");
  });

  it("omits lease_seconds for unsubscribe", () => {
    const url = new URL(
      buildVerificationUrl("https://sub.example/cb", {
        mode: "unsubscribe",
        topic: "https://example.com/feed",
        challenge: "c",
        leaseSeconds: 600,
      }),
    );
    expect(url.searchParams.has("hub.lease_seconds")).toBe(false);
  });
});

describe("generateChallenge", () => {
  it("produces a long, unique hex string", () => {
    const a = generateChallenge();
    const b = generateChallenge();
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(a.length).toBeGreaterThanOrEqual(48);
    expect(a).not.toBe(b);
  });
});

describe("verifyIntent", () => {
  it("confirms when the callback echoes the exact challenge with 2xx", async () => {
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      const challenge = new URL(input).searchParams.get("hub.challenge");
      return new Response(challenge, { status: 200 });
    });
    const result = await verifyIntent(
      "https://sub.example/cb",
      "https://example.com/feed",
      { mode: "subscribe", leaseSeconds: 600, fetch: fetchImpl },
    );
    expect(result).toEqual({ confirmed: true, status: 200 });
  });

  it("trims whitespace around the echoed challenge", async () => {
    const fetchImpl: FetchLike = vi.fn(async (input) => {
      const challenge = new URL(input).searchParams.get("hub.challenge");
      return new Response(`\n  ${challenge}\n`, { status: 202 });
    });
    const result = await verifyIntent(
      "https://sub.example/cb",
      "https://example.com/feed",
      { mode: "subscribe", challenge: undefined, fetch: fetchImpl },
    );
    expect(result.confirmed).toBe(true);
  });

  it("does not confirm when the body does not match", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () => new Response("wrong", { status: 200 }),
    );
    const result = await verifyIntent(
      "https://sub.example/cb",
      "https://example.com/feed",
      { mode: "subscribe", challenge: "expected", fetch: fetchImpl },
    );
    expect(result).toEqual({ confirmed: false, status: 200 });
  });

  it("does not confirm on a non-2xx status", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () => new Response("nope", { status: 404 }),
    );
    const result = await verifyIntent(
      "https://sub.example/cb",
      "https://example.com/feed",
      { mode: "unsubscribe", challenge: "c", fetch: fetchImpl },
    );
    expect(result).toEqual({ confirmed: false, status: 404 });
  });

  it("reports status 0 when the fetch throws", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await verifyIntent(
      "https://sub.example/cb",
      "https://example.com/feed",
      { mode: "subscribe", challenge: "c", fetch: fetchImpl },
    );
    expect(result).toEqual({ confirmed: false, status: 0 });
  });

  it("does not confirm (status 0) when the callback host is private (SSRF)", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () => new Response("c", { status: 200 }),
    );
    const result = await verifyIntent(
      "http://127.0.0.1/cb",
      "https://example.com/feed",
      { mode: "subscribe", challenge: "c", fetch: fetchImpl },
    );
    expect(result).toEqual({ confirmed: false, status: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
