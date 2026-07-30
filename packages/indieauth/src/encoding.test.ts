import { describe, expect, it, vi } from "vitest";

import { timingSafeEqual } from "./encoding.js";

describe("timingSafeEqual", () => {
  it("uses crypto.subtle.timingSafeEqual under the hood", () => {
    const spy = vi.spyOn(crypto.subtle, "timingSafeEqual");
    timingSafeEqual("same-length-a", "same-length-b");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects different-length inputs without an early return", () => {
    const spy = vi.spyOn(crypto.subtle, "timingSafeEqual");
    expect(timingSafeEqual("short", "much-longer-value")).toBe(false);
    // A safe implementation still calls the primitive (against itself) rather
    // than short-circuiting before ever touching it.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns true for identical strings", () => {
    expect(timingSafeEqual("test", "test")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(timingSafeEqual("abc", "def")).toBe(false);
  });

  it("returns false for different-length strings", () => {
    expect(timingSafeEqual("a", "ab")).toBe(false);
  });
});
