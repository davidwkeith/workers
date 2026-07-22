import { describe, expect, it } from "vitest";

import { api, resetDb, obtainAccessToken } from "./test-harness.js";
import type { MastodonBackend } from "./backend.js";
import { encodeSnowflake } from "./snowflake.js";

function fakeBackend(entries: unknown[]): MastodonBackend {
  return {
    account: async () => ({
      counts: { followers: 0, following: 0, statuses: 0 },
    }),
    timeline: async () => ({ entries: entries as never }),
    notifications: async () => ({ entries: [] }),
    entry: async () => null,
  };
}

describe("GET /api/v1/timelines/home", () => {
  it("401s without a bearer token", async () => {
    await resetDb();
    const response = await api()(
      new Request("https://owner.example/api/v1/timelines/home"),
    );
    expect(response.status).toBe(401);
  });

  it("422s for an app-level (client_credentials) token", async () => {
    await resetDb();
    const token = await obtainAccessToken("client_credentials");
    const response = await api()(
      new Request("https://owner.example/api/v1/timelines/home", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(422);
  });

  it("returns mapped statuses with a Link header when authenticated", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const entry = {
      id: encodeSnowflake(1_753_000_000_000, 1),
      receivedAt: 1_753_000_000_000,
      objectType: "Note",
      relayedBy: null,
      activity: {
        type: "Create",
        actor: "https://remote.example/users/alice",
        object: { type: "Note", content: "<p>hi</p>" },
      },
    };
    const cfgWithBackend = {
      ...(await import("./test-harness.js")).testConfig,
      backend: fakeBackend([entry]),
    };
    const response = await api(cfgWithBackend)(
      new Request("https://owner.example/api/v1/timelines/home", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(entry.id);
    expect(response.headers.get("link")).toContain('rel="next"');
  });

  it("returns an empty array with no Link header when the timeline is empty", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const cfgWithBackend = {
      ...(await import("./test-harness.js")).testConfig,
      backend: fakeBackend([]),
    };
    const response = await api(cfgWithBackend)(
      new Request("https://owner.example/api/v1/timelines/home", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown[];
    expect(body).toHaveLength(0);
    expect(response.headers.get("link")).toBeNull();
  });

  it("clamps limit to the configured max", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    let capturedLimit: number | undefined;
    const backend: MastodonBackend = {
      account: async () => ({
        counts: { followers: 0, following: 0, statuses: 0 },
      }),
      timeline: async (query) => {
        capturedLimit = query.limit;
        return { entries: [] };
      },
      notifications: async () => ({ entries: [] }),
      entry: async () => null,
    };
    const cfgWithBackend = {
      ...(await import("./test-harness.js")).testConfig,
      backend,
      pageSize: { default: 20, max: 5 },
    };
    const response = await api(cfgWithBackend)(
      new Request("https://owner.example/api/v1/timelines/home?limit=1000", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(capturedLimit).toBe(5);
  });
});
