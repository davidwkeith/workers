import { describe, expect, it } from "vitest";

import { api, resetDb, obtainAccessToken, testConfig } from "./test-harness.js";
import type { MastodonBackend } from "./backend.js";
import { encodeSnowflake } from "./snowflake.js";

describe("GET /api/v1/statuses/:id", () => {
  it("404s for an unknown id", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const backend: MastodonBackend = {
      account: async () => ({
        counts: { followers: 0, following: 0, statuses: 0 },
      }),
      timeline: async () => ({ entries: [] }),
      notifications: async () => ({ entries: [] }),
      entry: async () => null,
    };
    const response = await api({ ...testConfig, backend })(
      new Request(
        `https://owner.example/api/v1/statuses/${encodeSnowflake(1, 1)}`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      ),
    );
    expect(response.status).toBe(404);
  });

  it("200s with the mapped Status for a known id", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const id = encodeSnowflake(1_753_000_000_020, 1);
    const backend: MastodonBackend = {
      account: async () => ({
        counts: { followers: 0, following: 0, statuses: 0 },
      }),
      timeline: async () => ({ entries: [] }),
      notifications: async () => ({ entries: [] }),
      entry: async (requested) =>
        requested === id
          ? {
              id,
              receivedAt: 1_753_000_000_020,
              objectType: "Note",
              relayedBy: null,
              activity: {
                type: "Create",
                actor: "https://remote.example/users/alice",
                object: { type: "Note", content: "<p>hi</p>" },
              },
            }
          : null,
    };
    const response = await api({ ...testConfig, backend })(
      new Request(`https://owner.example/api/v1/statuses/${id}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string }).id).toBe(id);
  });

  it("leaves exact-match routes (e.g. GET /api/v1/instance) unaffected by the dynamic-route fallback", async () => {
    await resetDb();
    const response = await api()(
      new Request("https://owner.example/api/v1/instance"),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { title: string }).title).toBe(
      testConfig.instance.title,
    );
  });
});
