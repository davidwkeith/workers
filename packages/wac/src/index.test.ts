import { describe, expect, it } from "vitest";

import { evaluateAccess } from "./index";

describe("@dwk/wac", () => {
  it("exposes evaluateAccess", () => {
    expect(typeof evaluateAccess).toBe("function");
  });

  it("is not implemented yet", () => {
    expect(() => evaluateAccess({}, { mode: "Read" })).toThrow(
      /not implemented/i,
    );
  });
});
