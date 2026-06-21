import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  it("applies defaults and derives the endpoint path", () => {
    const resolved = resolveConfig({
      baseUrl: "https://example.com",
      me: "https://example.com/",
    });
    expect(resolved.microsubEndpoint).toBe("https://example.com/microsub");
    expect(resolved.microsubPath).toBe("/microsub");
    expect(resolved.tokenIssuer).toBe("https://example.com");
    expect(resolved.pageSize).toBe(20);
    expect(resolved.maxItemsPerChannel).toBe(5000);
    expect(resolved.checkRevocation).toBe(true);
    expect(resolved.checkDpopReplay).toBe(true);
  });

  it("honours an explicit endpoint, page size, and retention ceiling", () => {
    const resolved = resolveConfig({
      baseUrl: "https://example.com",
      me: "https://example.com/",
      microsubEndpoint: "https://example.com/api/microsub",
      pageSize: 5,
      maxItemsPerChannel: 100,
      tokenIssuer: "https://issuer.example",
    });
    expect(resolved.microsubPath).toBe("/api/microsub");
    expect(resolved.pageSize).toBe(5);
    expect(resolved.maxItemsPerChannel).toBe(100);
    expect(resolved.tokenIssuer).toBe("https://issuer.example");
  });

  it("clamps non-positive page sizes back to the default", () => {
    const resolved = resolveConfig({
      baseUrl: "https://e.com",
      me: "https://e.com/",
      pageSize: 0,
    });
    expect(resolved.pageSize).toBe(20);
  });

  it("rejects an invalid baseUrl", () => {
    expect(() =>
      resolveConfig({ baseUrl: "not a url", me: "https://e.com/" }),
    ).toThrow(/baseUrl/);
  });

  it("rejects an invalid me", () => {
    expect(() =>
      resolveConfig({ baseUrl: "https://e.com", me: "ftp://nope" }),
    ).toThrow(/me/);
  });

  it("rejects an invalid explicit endpoint URL", () => {
    expect(() =>
      resolveConfig({
        baseUrl: "https://e.com",
        me: "https://e.com/",
        microsubEndpoint: "bad",
      }),
    ).toThrow(/microsubEndpoint/);
  });
});
