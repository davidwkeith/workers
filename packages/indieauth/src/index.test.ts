import { describe, expect, it } from "vitest";

import { createIndieAuth } from "./index";

describe("@dwk/indieauth", () => {
  it("returns a 501 handler until implemented", async () => {
    const handler = createIndieAuth({
      baseUrl: "https://example.com",
      issuer: "https://example.com",
    });

    const response = await handler(
      new Request("https://example.com/auth"),
      { TOKEN_SIGNING_KEY: "test" },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(501);
  });
});
