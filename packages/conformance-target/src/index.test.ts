/**
 * Tests for top-level fetch handler error handling.
 */

import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ConformanceEnv } from "./index.js";
import worker from "./index.js";

const BASE = "https://conformance.test";

describe("fetch error handling", () => {
  it("returns a plain-text 500 instead of throwing when an unhandled error occurs", async () => {
    // Create a broken env by omitting required bindings (e.g., D1_DB).
    // This will cause configsFor to throw when buildMounts tries to initialize.
    const brokenEnv = {
      // Deliberately incomplete env to force an error
    } as unknown as ConformanceEnv;

    const request = new Request(`${BASE}/`, {
      method: "GET",
    }) as unknown as Parameters<typeof worker.fetch>[0];

    const res = await worker.fetch(
      request,
      brokenEnv,
      createExecutionContext(),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).not.toContain("application/json");
    const text = await res.text();
    expect(text).toBe("Internal Server Error");
  });
});
