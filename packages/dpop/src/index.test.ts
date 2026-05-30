import { describe, expect, it } from "vitest";

import { verifyDpopProof } from "./index";

describe("@dwk/dpop", () => {
  it("exposes verifyDpopProof", () => {
    expect(typeof verifyDpopProof).toBe("function");
  });

  it("is not implemented yet", () => {
    expect(() =>
      verifyDpopProof({
        proof: "",
        request: { method: "GET", url: "https://example.com/" },
      }),
    ).toThrow(/not implemented/i);
  });
});
