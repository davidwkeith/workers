import { describe, expect, it } from "vitest";

import { createMicropub } from "./index";

describe("@dwk/micropub", () => {
  it("returns a 501 handler until implemented", async () => {
    const handler = createMicropub({ baseUrl: "https://example.com" });

    const response = await handler(
      new Request("https://example.com/micropub"),
      { MEDIA: {} as R2Bucket },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(501);
  });
});
