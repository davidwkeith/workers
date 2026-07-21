import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createMastodonApi } from "./index.js";
import type { MastodonApiConfig, MastodonApiEnv } from "./index.js";

export const config: MastodonApiConfig = {
  baseUrl: "https://owner.example",
  instance: { title: "Owner's site" },
  account: { username: "owner" },
  approveAuthorization: async () => ({ approved: true }),
};

const ctx = {} as ExecutionContext;

export function api(cfg: MastodonApiConfig = config) {
  const handler = createMastodonApi(cfg);
  return (request: Request) =>
    handler(request, env as unknown as MastodonApiEnv, ctx);
}

describe("createMastodonApi shell", () => {
  it("fails loudly when AUTH_DB is missing", async () => {
    const handler = createMastodonApi(config);
    await expect(
      handler(
        new Request("https://owner.example/api/v1/instance"),
        {} as MastodonApiEnv,
        ctx,
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
});
