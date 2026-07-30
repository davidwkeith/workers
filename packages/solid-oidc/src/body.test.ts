import { describe, expect, it } from "vitest";

import { readRequestBodyCapped } from "./body.js";

describe("readRequestBodyCapped", () => {
  it("reads a body under the cap", async () => {
    const request = new Request("https://example.test/token", {
      method: "POST",
      body: "grant_type=authorization_code",
    });
    const bytes = await readRequestBodyCapped(request, 1024);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe(
      "grant_type=authorization_code",
    );
  });

  it("returns null when the body exceeds the cap", async () => {
    const request = new Request("https://example.test/token", {
      method: "POST",
      body: "x".repeat(2000),
    });
    const bytes = await readRequestBodyCapped(request, 1024);
    expect(bytes).toBeNull();
  });
});
