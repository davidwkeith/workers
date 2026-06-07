import { describe, it, expect, vi } from "vitest";
import {
  verifyIntent,
  buildVerificationUrl,
  generateChallenge,
  buildDenialUrl,
  notifyDenial,
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

describe("buildDenialUrl", () => {
  it("appends hub.mode=denied, hub.topic and hub.reason, preserving query", () => {
    const url = new URL(
      buildDenialUrl("https://sub.example/cb?token=abc", {
        topic: "https://example.com/feed",
        reason: "verification_failed",
      }),
    );
    expect(url.searchParams.get("token")).toBe("abc");
    expect(url.searchParams.get("hub.mode")).toBe("denied");
    expect(url.searchParams.get("hub.topic")).toBe("https://example.com/feed");
    expect(url.searchParams.get("hub.reason")).toBe("verification_failed");
  });

  it("omits hub.reason when none is given", () => {
    const url = new URL(
      buildDenialUrl("https://sub.example/cb", {
        topic: "https://example.com/feed",
      }),
    );
    expect(url.searchParams.has("hub.reason")).toBe(false);
  });
});

describe("notifyDenial", () => {
  it("issues a GET to the callback with the denial params", async () => {
    let seen = "";
    const fetchImpl: FetchLike = vi.fn(async (input, init) => {
      seen = input;
      expect(init?.method ?? "GET").toBe("GET");
      return new Response(null, { status: 200 });
    });
    await notifyDenial("https://sub.example/cb", "https://example.com/feed", {
      reason: "verification_failed",
      fetch: fetchImpl,
    });
    const url = new URL(seen);
    expect(url.searchParams.get("hub.mode")).toBe("denied");
    expect(url.searchParams.get("hub.topic")).toBe("https://example.com/feed");
    expect(url.searchParams.get("hub.reason")).toBe("verification_failed");
  });

  it("never throws when the callback is unreachable, and logs notified:false", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error("refused");
    });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    await expect(
      notifyDenial("https://sub.example/cb", "https://example.com/feed", {
        fetch: fetchImpl,
        logger,
      }),
    ).resolves.toBeUndefined();
    // The denial event is still emitted — silence would hide the denial — but
    // `notified` reflects that the callback never accepted the GET.
    expect(logger.info).toHaveBeenCalledWith(
      "websub.subscription.denied",
      expect.objectContaining({ notified: false }),
    );
  });

  it("logs notified:true when the callback accepts the denial GET", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () => new Response(null, { status: 200 }),
    );
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    await notifyDenial("https://sub.example/cb", "https://example.com/feed", {
      fetch: fetchImpl,
      logger,
    });
    expect(logger.info).toHaveBeenCalledWith(
      "websub.subscription.denied",
      expect.objectContaining({ notified: true }),
    );
  });

  it("does not GET a private callback host (SSRF)", async () => {
    const fetchImpl: FetchLike = vi.fn(
      async () => new Response(null, { status: 200 }),
    );
    await notifyDenial("http://127.0.0.1/cb", "https://example.com/feed", {
      fetch: fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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
