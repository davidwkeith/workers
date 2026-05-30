import { describe, expect, it } from "vitest";

import { createWebmention } from "./index";

describe("@dwk/webmention", () => {
  it("returns a 501 handler until implemented", async () => {
    const handler = createWebmention({ baseUrl: "https://example.com" });

    const response = await handler(
      new Request("https://example.com/webmention"),
      { VERIFICATION_QUEUE: {} as Queue },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(501);
  });
});
