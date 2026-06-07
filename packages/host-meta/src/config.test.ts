import { describe, it, expect } from "vitest";

import { resolveConfig } from "./index";

describe("resolveConfig", () => {
  it("throws when neither a WebFinger URL nor links are configured", () => {
    expect(() => resolveConfig({})).toThrow(/at least one link/);
  });

  it("throws when only an empty links array is configured", () => {
    expect(() => resolveConfig({ links: [] })).toThrow(/at least one link/);
  });

  it("accepts a WebFinger URL alone and pre-computes the document", () => {
    const resolved = resolveConfig({
      webfingerUrl: "https://example.com/.well-known/webfinger",
    });
    expect(resolved.document.links[0]?.rel).toBe("lrdd");
  });

  it("accepts static links alone", () => {
    const resolved = resolveConfig({
      links: [{ rel: "author", href: "https://example.com/about" }],
    });
    expect(resolved.document.links[0]?.rel).toBe("author");
  });

  it("defaults logger and metrics to no-ops", () => {
    const resolved = resolveConfig({ webfingerUrl: "https://example.com/wf" });
    expect(typeof resolved.logger.info).toBe("function");
    expect(typeof resolved.metrics.count).toBe("function");
  });
});
