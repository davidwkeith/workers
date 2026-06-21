import { describe, expect, it } from "vitest";

import { derivationContext, deriveComponentValue } from "./components.js";
import type { HttpMessage } from "./types.js";

/**
 * Unit tests for the RFC 9421 §2.2 derived-component values. The round-trip
 * tests exercise the common ones via signing; these pin every `@`-derived name
 * (including the empty-`@query` fallback and the unsupported-name → `null`
 * path) and the case-insensitive header view directly.
 */

function ctxFor(message: Partial<HttpMessage>) {
  const ctx = derivationContext({
    method: "post",
    url: "https://Example.com/Path/to?x=1&y=2",
    headers: {},
    ...message,
  });
  if (ctx === null) throw new Error("expected a derivation context");
  return ctx;
}

describe("derivationContext", () => {
  it("returns null for a malformed URL", () => {
    expect(
      derivationContext({ method: "GET", url: "not a url", headers: {} }),
    ).toBeNull();
  });
});

describe("deriveComponentValue — derived components", () => {
  it("uppercases @method", () => {
    expect(deriveComponentValue(ctxFor({}), "@method")).toBe("POST");
  });

  it("returns the full href for @target-uri", () => {
    expect(deriveComponentValue(ctxFor({}), "@target-uri")).toBe(
      "https://example.com/Path/to?x=1&y=2",
    );
  });

  it("lowercases the host for @authority", () => {
    expect(deriveComponentValue(ctxFor({}), "@authority")).toBe("example.com");
  });

  it("returns the bare scheme for @scheme", () => {
    expect(deriveComponentValue(ctxFor({}), "@scheme")).toBe("https");
  });

  it("returns path+query for @request-target", () => {
    expect(deriveComponentValue(ctxFor({}), "@request-target")).toBe(
      "/Path/to?x=1&y=2",
    );
  });

  it("returns the path for @path", () => {
    expect(deriveComponentValue(ctxFor({}), "@path")).toBe("/Path/to");
  });

  it("returns the query string for @query", () => {
    expect(deriveComponentValue(ctxFor({}), "@query")).toBe("?x=1&y=2");
  });

  it("returns '?' for @query when there is no query string", () => {
    const ctx = ctxFor({ url: "https://example.com/p" });
    expect(deriveComponentValue(ctx, "@query")).toBe("?");
  });

  it("returns null for an unsupported @-derived name", () => {
    expect(deriveComponentValue(ctxFor({}), "@status")).toBeNull();
  });
});

describe("deriveComponentValue — header fields", () => {
  it("reads a header case-insensitively", () => {
    const ctx = ctxFor({ headers: { "Content-Type": "text/plain" } });
    expect(deriveComponentValue(ctx, "content-type")).toBe("text/plain");
  });

  it("joins a multi-valued header with ', '", () => {
    const ctx = ctxFor({ headers: { "X-Tag": ["a", "b"] } });
    expect(deriveComponentValue(ctx, "x-tag")).toBe("a, b");
  });

  it("returns null for a header the message does not carry", () => {
    expect(deriveComponentValue(ctxFor({}), "x-absent")).toBeNull();
  });
});
