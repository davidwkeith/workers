import { describe, it, expect } from "vitest";

import { normalizeResource } from "./resource";

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
