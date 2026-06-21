import { describe, it, expect } from "vitest";

import { normalizeResource, isWellFormedResource } from "./resource.js";

describe("normalizeResource", () => {
  it("lowercases the scheme and host of an acct: URI", () => {
    expect(normalizeResource("ACCT:alice@EXAMPLE.COM")).toBe(
      "acct:alice@example.com",
    );
  });

  it("preserves the case of the acct: local part (case-sensitive)", () => {
    expect(normalizeResource("acct:Alice@Example.com")).toBe(
      "acct:Alice@example.com",
    );
  });

  it("normalizes a mailto: host the same way", () => {
    expect(normalizeResource("MAILTO:Bob@Mail.EXAMPLE.com")).toBe(
      "mailto:Bob@mail.example.com",
    );
  });

  it("leaves an acct: value without a host part untouched beyond the scheme", () => {
    expect(normalizeResource("ACCT:nohost")).toBe("acct:nohost");
  });

  it("lowercases the scheme and host of an https: URI", () => {
    expect(normalizeResource("HTTPS://Example.COM/Path")).toBe(
      "https://example.com/Path",
    );
  });

  it("returns a string with no scheme unchanged", () => {
    expect(normalizeResource("not-a-uri")).toBe("not-a-uri");
  });

  it("lowercases only the scheme of an unknown scheme", () => {
    expect(normalizeResource("URN:Example:Resource")).toBe(
      "urn:Example:Resource",
    );
  });

  it("is idempotent", () => {
    const once = normalizeResource("ACCT:alice@EXAMPLE.COM");
    expect(normalizeResource(once)).toBe(once);
  });
});

describe("isWellFormedResource", () => {
  it("accepts an acct: URI", () => {
    expect(isWellFormedResource("acct:alice@example.com")).toBe(true);
  });

  it("accepts a mailto: URI", () => {
    expect(isWellFormedResource("mailto:bob@example.com")).toBe(true);
  });

  it("accepts a parseable https: URI", () => {
    expect(isWellFormedResource("https://example.com/users/alice")).toBe(true);
  });

  it("accepts an arbitrary scheme without parsing its body", () => {
    expect(isWellFormedResource("urn:example:resource")).toBe(true);
  });

  it("accepts a scheme regardless of case", () => {
    expect(isWellFormedResource("ACCT:alice@example.com")).toBe(true);
  });

  it("rejects a value with no scheme", () => {
    expect(isWellFormedResource("alice@example.com")).toBe(false);
  });

  it("rejects a bare token", () => {
    expect(isWellFormedResource("not-a-uri")).toBe(false);
  });

  it("rejects a leading-colon value (empty scheme)", () => {
    expect(isWellFormedResource(":alice@example.com")).toBe(false);
  });

  it("rejects a scheme that starts with a digit (RFC 3986 §3.1)", () => {
    expect(isWellFormedResource("1http://example.com")).toBe(false);
  });

  it("rejects an unparseable http: URI", () => {
    expect(isWellFormedResource("https://")).toBe(false);
  });
});
