import { describe, expect, it } from "vitest";

import { createMastodonApi } from "./index.js";
import type { MastodonApiEnv } from "./index.js";
import { api, testConfig, testCtx } from "./test-harness.js";

describe("createMastodonApi shell", () => {
  it("fails loudly when AUTH_DB is missing", async () => {
    const handler = createMastodonApi(testConfig);
    await expect(
      handler(
        new Request("https://owner.example/api/v1/instance"),
        {} as MastodonApiEnv,
        testCtx,
      ),
    ).rejects.toThrow(/AUTH_DB/);
  });

  it("404s unknown /api/ paths with the Mastodon error shape", async () => {
    const res = await api()(
      new Request("https://owner.example/api/v1/does-not-exist"),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Record not found" });
  });

  it("answers CORS preflight and marks responses CORS-open", async () => {
    const preflight = await api()(
      new Request("https://owner.example/api/v1/instance", {
        method: "OPTIONS",
        headers: { origin: "https://elk.zone" },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const res = await api()(new Request("https://owner.example/api/v1/nope"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("404s a dynamic-route path with malformed percent-encoding instead of throwing", async () => {
    const res = await api()(
      new Request("https://owner.example/api/v1/accounts/%zz"),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Record not found" });
  });

  it("404s a malformed-percent-encoded statuses path the same way", async () => {
    const res = await api()(
      new Request("https://owner.example/api/v1/statuses/%zz"),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Record not found" });
  });
});
