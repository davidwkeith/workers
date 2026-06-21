import { describe, it, expect } from "vitest";
import {
  resolveConfig,
  normalizeTopic,
  clampLease,
  DEFAULT_MAX_LEASE_SECONDS,
  DEFAULT_MIN_LEASE_SECONDS,
} from "./config.js";

describe("normalizeTopic", () => {
  it("folds default ports, bare paths, and fragments", () => {
    expect(normalizeTopic("https://example.com:443/")).toBe(
      "https://example.com",
    );
    expect(normalizeTopic("http://example.com:80/feed#x")).toBe(
      "http://example.com/feed",
    );
  });

  it("preserves the query string", () => {
    expect(normalizeTopic("https://example.com/feed?format=atom")).toBe(
      "https://example.com/feed?format=atom",
    );
  });

  it("rejects non-http(s) and unparseable URLs", () => {
    expect(normalizeTopic("ftp://example.com/feed")).toBeNull();
    expect(normalizeTopic("not a url")).toBeNull();
  });
});

describe("resolveConfig", () => {
  it("derives an allowlist predicate from allowedTopics (normalized match)", () => {
    const resolved = resolveConfig({
      baseUrl: "https://hub.example",
      allowedTopics: ["https://example.com/feed"],
    });
    expect(resolved.isAllowedTopic("https://example.com/feed")).toBe(true);
    // Default port and trailing fragment normalize to the same topic.
    expect(resolved.isAllowedTopic("https://example.com:443/feed#a")).toBe(
      true,
    );
    expect(resolved.isAllowedTopic("https://example.com/other")).toBe(false);
  });

  it("prefers an explicit isAllowedTopic predicate", () => {
    const resolved = resolveConfig({
      baseUrl: "https://hub.example",
      isAllowedTopic: (t) => t.startsWith("https://example.com/"),
    });
    expect(resolved.isAllowedTopic("https://example.com/anything")).toBe(true);
    expect(resolved.isAllowedTopic("https://evil.example/x")).toBe(false);
  });

  it("throws when no topic policy is configured", () => {
    expect(() => resolveConfig({ baseUrl: "https://hub.example" })).toThrow(
      /allowedTopics or isAllowedTopic/,
    );
  });

  it("defaults hubUrl to baseUrl and honors an override", () => {
    expect(
      resolveConfig({ baseUrl: "https://hub.example", allowedTopics: [] })
        .hubUrl,
    ).toBe("https://hub.example");
    expect(
      resolveConfig({
        baseUrl: "https://hub.example",
        hubUrl: "https://hub.example/websub",
        allowedTopics: [],
      }).hubUrl,
    ).toBe("https://hub.example/websub");
  });

  it("clamps the default lease into [min, max]", () => {
    const resolved = resolveConfig({
      baseUrl: "https://hub.example",
      allowedTopics: [],
      minLeaseSeconds: 100,
      maxLeaseSeconds: 1000,
      defaultLeaseSeconds: 5000,
    });
    expect(resolved.defaultLeaseSeconds).toBe(1000);
  });

  it("uses the documented default lease bounds", () => {
    const resolved = resolveConfig({
      baseUrl: "https://hub.example",
      allowedTopics: [],
    });
    expect(resolved.minLeaseSeconds).toBe(DEFAULT_MIN_LEASE_SECONDS);
    expect(resolved.maxLeaseSeconds).toBe(DEFAULT_MAX_LEASE_SECONDS);
    expect(resolved.defaultLeaseSeconds).toBe(DEFAULT_MAX_LEASE_SECONDS);
  });

  it("throws when min exceeds max", () => {
    expect(() =>
      resolveConfig({
        baseUrl: "https://hub.example",
        allowedTopics: [],
        minLeaseSeconds: 1000,
        maxLeaseSeconds: 100,
      }),
    ).toThrow(/minLeaseSeconds/);
  });
});

describe("clampLease", () => {
  it("clamps to the configured bounds", () => {
    const resolved = resolveConfig({
      baseUrl: "https://hub.example",
      allowedTopics: [],
      minLeaseSeconds: 100,
      maxLeaseSeconds: 1000,
    });
    expect(clampLease(50, resolved)).toBe(100);
    expect(clampLease(500, resolved)).toBe(500);
    expect(clampLease(5000, resolved)).toBe(1000);
  });
});
