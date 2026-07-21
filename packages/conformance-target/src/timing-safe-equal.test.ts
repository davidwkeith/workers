import { describe, expect, it } from "vitest";

import { timingSafeEqual } from "./timing-safe-equal.js";

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("secret-token", "secret-token")).toBe(true);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("returns false when lengths differ", () => {
    expect(timingSafeEqual("short", "much-longer-value")).toBe(false);
  });

  it("returns false when same length but content differs", () => {
    expect(timingSafeEqual("aaaaaaaa", "aaaaaaab")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(timingSafeEqual("Secret", "secret")).toBe(false);
  });
});
