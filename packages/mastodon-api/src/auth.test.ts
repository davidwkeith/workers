import { describe, expect, it } from "vitest";

import { tokenHasScope } from "./auth.js";

describe("tokenHasScope", () => {
  it("matches an exact granted scope", () => {
    expect(tokenHasScope("read write", "write")).toBe(true);
  });

  it("a broad granted scope covers its granular child", () => {
    expect(tokenHasScope("read write", "write:statuses")).toBe(true);
  });

  it("a granular granted scope satisfies itself", () => {
    expect(tokenHasScope("read write:statuses", "write:statuses")).toBe(true);
  });

  it("a granular granted scope does not grant the broad required scope", () => {
    // write:statuses must not satisfy a required plain `write`.
    expect(tokenHasScope("read write:statuses", "write")).toBe(false);
  });

  it("read does not grant write", () => {
    expect(tokenHasScope("read follow push", "write:statuses")).toBe(false);
    expect(tokenHasScope("read", "write")).toBe(false);
  });

  it("tolerates arbitrary whitespace and empty segments", () => {
    expect(tokenHasScope("  read   write  ", "write")).toBe(true);
    expect(tokenHasScope("", "write")).toBe(false);
  });
});
