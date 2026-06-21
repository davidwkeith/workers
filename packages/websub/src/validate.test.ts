import { describe, it, expect } from "vitest";
import { resolveConfig, type ResolvedConfig } from "./config.js";
import {
  validateSubscribe,
  validatePublish,
  readHubParams,
  MAX_SECRET_BYTES,
} from "./validate.js";

const config: ResolvedConfig = resolveConfig({
  baseUrl: "https://hub.example",
  allowedTopics: ["https://example.com/feed"],
  minLeaseSeconds: 100,
  maxLeaseSeconds: 1000,
  defaultLeaseSeconds: 600,
});

function params(pairs: Record<string, string>) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(pairs)) form.set(k, v);
  return readHubParams(form);
}

describe("validateSubscribe", () => {
  it("accepts a well-formed subscribe and applies the default lease", () => {
    const result = validateSubscribe(
      params({
        "hub.mode": "subscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://example.com/feed",
      }),
      config,
    );
    expect(result).toEqual({
      ok: true,
      mode: "subscribe",
      callback: "https://sub.example/cb",
      topic: "https://example.com/feed",
      leaseSeconds: 600,
    });
  });

  it("clamps a requested lease into the hub bounds", () => {
    const low = validateSubscribe(
      params({
        "hub.mode": "subscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://example.com/feed",
        "hub.lease_seconds": "10",
      }),
      config,
    );
    expect(low.ok && low.leaseSeconds).toBe(100);
    const high = validateSubscribe(
      params({
        "hub.mode": "subscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://example.com/feed",
        "hub.lease_seconds": "99999",
      }),
      config,
    );
    expect(high.ok && high.leaseSeconds).toBe(1000);
  });

  it("carries a secret through", () => {
    const result = validateSubscribe(
      params({
        "hub.mode": "subscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://example.com/feed",
        "hub.secret": "s3cr3t",
      }),
      config,
    );
    expect(result.ok && result.secret).toBe("s3cr3t");
  });

  it("rejects an unsupported topic", () => {
    const result = validateSubscribe(
      params({
        "hub.mode": "subscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://example.com/not-a-feed",
      }),
      config,
    );
    expect(result).toEqual({ ok: false, error: "topic_not_supported" });
  });

  it("rejects a non-url callback and topic", () => {
    expect(
      validateSubscribe(
        params({
          "hub.mode": "subscribe",
          "hub.callback": "not-a-url",
          "hub.topic": "https://example.com/feed",
        }),
        config,
      ),
    ).toEqual({ ok: false, error: "callback_not_url" });
    expect(
      validateSubscribe(
        params({
          "hub.mode": "subscribe",
          "hub.callback": "https://sub.example/cb",
          "hub.topic": "javascript:alert(1)",
        }),
        config,
      ),
    ).toEqual({ ok: false, error: "topic_not_url" });
  });

  it("rejects a missing or unknown mode", () => {
    expect(
      validateSubscribe(
        params({ "hub.callback": "https://sub.example/cb" }),
        config,
      ),
    ).toEqual({ ok: false, error: "invalid_mode" });
    expect(
      validateSubscribe(params({ "hub.mode": "publish" }), config),
    ).toEqual({ ok: false, error: "invalid_mode" });
  });

  it("rejects an over-long secret", () => {
    const result = validateSubscribe(
      params({
        "hub.mode": "subscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://example.com/feed",
        "hub.secret": "x".repeat(MAX_SECRET_BYTES),
      }),
      config,
    );
    expect(result).toEqual({ ok: false, error: "secret_too_long" });
  });

  it("clamps a non-positive lease up to the hub minimum (§5.1 request, not constraint)", () => {
    const zero = validateSubscribe(
      params({
        "hub.mode": "subscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://example.com/feed",
        "hub.lease_seconds": "0",
      }),
      config,
    );
    expect(zero.ok && zero.leaseSeconds).toBe(100);
    const negative = validateSubscribe(
      params({
        "hub.mode": "subscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://example.com/feed",
        "hub.lease_seconds": "-5",
      }),
      config,
    );
    expect(negative.ok && negative.leaseSeconds).toBe(100);
  });

  it("rejects a non-numeric lease", () => {
    const result = validateSubscribe(
      params({
        "hub.mode": "subscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://example.com/feed",
        "hub.lease_seconds": "soon",
      }),
      config,
    );
    expect(result).toEqual({ ok: false, error: "invalid_lease_seconds" });
  });

  it("accepts unsubscribe", () => {
    const result = validateSubscribe(
      params({
        "hub.mode": "unsubscribe",
        "hub.callback": "https://sub.example/cb",
        "hub.topic": "https://example.com/feed",
      }),
      config,
    );
    expect(result.ok && result.mode).toBe("unsubscribe");
  });
});

describe("validatePublish", () => {
  it("accepts hub.url for a supported topic", () => {
    const result = validatePublish(
      params({ "hub.mode": "publish", "hub.url": "https://example.com/feed" }),
      config,
    );
    expect(result).toEqual({
      ok: true,
      mode: "publish",
      topic: "https://example.com/feed",
    });
  });

  it("falls back to hub.topic when hub.url is absent", () => {
    const result = validatePublish(
      params({
        "hub.mode": "publish",
        "hub.topic": "https://example.com/feed",
      }),
      config,
    );
    expect(result.ok && result.topic).toBe("https://example.com/feed");
  });

  it("rejects a missing url", () => {
    expect(validatePublish(params({ "hub.mode": "publish" }), config)).toEqual({
      ok: false,
      error: "url_required",
    });
  });

  it("rejects an unsupported topic", () => {
    expect(
      validatePublish(
        params({
          "hub.mode": "publish",
          "hub.url": "https://evil.example/feed",
        }),
        config,
      ),
    ).toEqual({ ok: false, error: "topic_not_supported" });
  });
});
