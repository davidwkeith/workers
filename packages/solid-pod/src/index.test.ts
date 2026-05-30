import { describe, expect, it } from "vitest";

import { createSolidPod, SolidPodObject } from "./index";

describe("@dwk/solid-pod", () => {
  it("returns a 501 handler until implemented", async () => {
    const handler = createSolidPod({ baseUrl: "https://example.com" });

    const response = await handler(
      new Request("https://example.com/"),
      { POD: {} as DurableObjectNamespace, BLOBS: {} as R2Bucket },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(501);
  });

  it("exports the per-pod Durable Object class", () => {
    expect(typeof SolidPodObject).toBe("function");
  });
});
