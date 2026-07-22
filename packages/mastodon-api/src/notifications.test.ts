import { describe, expect, it } from "vitest";

import { api, resetDb, obtainAccessToken, testConfig } from "./test-harness.js";
import type { MastodonBackend } from "./backend.js";
import { encodeSnowflake } from "./snowflake.js";

function fakeBackend(entries: unknown[]): MastodonBackend {
  return {
    account: async () => ({
      counts: { followers: 0, following: 0, statuses: 0 },
    }),
    timeline: async () => ({ entries: [] }),
    notifications: async () => ({ entries: entries as never }),
    entry: async () => null,
  };
}

describe("GET /api/v1/notifications", () => {
  it("401s without a bearer token", async () => {
    await resetDb();
    const response = await api()(
      new Request("https://owner.example/api/v1/notifications"),
    );
    expect(response.status).toBe(401);
  });

  it("422s for an app-level (client_credentials) token", async () => {
    await resetDb();
    const token = await obtainAccessToken("client_credentials");
    const response = await api()(
      new Request("https://owner.example/api/v1/notifications", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(422);
  });

  it("maps a Like row to a favourite notification, dropping unmapped rows", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const like = {
      id: encodeSnowflake(1_753_000_000_010, 1),
      receivedAt: 1_753_000_000_010,
      objectType: null,
      relayedBy: null,
      activity: {
        type: "Like",
        actor: "https://remote.example/users/carol",
        object: "https://owner.example/users/owner/outbox/1",
      },
    };
    // A row that notificationEntity maps to null (a Follow, unhandled until
    // phase 3) must not leak a `null` entry into the response array.
    const follow = {
      id: encodeSnowflake(1_753_000_000_011, 1),
      receivedAt: 1_753_000_000_011,
      objectType: null,
      relayedBy: null,
      activity: {
        type: "Follow",
        actor: "https://remote.example/users/dave",
        object: "https://owner.example/users/owner",
      },
    };
    const cfg = { ...testConfig, backend: fakeBackend([like, follow]) };
    const response = await api(cfg)(
      new Request("https://owner.example/api/v1/notifications", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { type: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.type).toBe("favourite");
    expect(body.every((n) => n !== null)).toBe(true);
  });

  it("returns a Link header when the page has real entries", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const like = {
      id: encodeSnowflake(1_753_000_000_020, 1),
      receivedAt: 1_753_000_000_020,
      objectType: null,
      relayedBy: null,
      activity: {
        type: "Like",
        actor: "https://remote.example/users/carol",
        object: "https://owner.example/users/owner/outbox/1",
      },
    };
    const cfg = { ...testConfig, backend: fakeBackend([like]) };
    const response = await api(cfg)(
      new Request("https://owner.example/api/v1/notifications", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("link")).toContain('rel="next"');
  });

  it("returns an empty array with no Link header when there are no entries", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const cfg = { ...testConfig, backend: fakeBackend([]) };
    const response = await api(cfg)(
      new Request("https://owner.example/api/v1/notifications", {
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
      timeline: async () => ({ entries: [] }),
      notifications: async (query) => {
        capturedLimit = query.limit;
        return { entries: [] };
      },
      entry: async () => null,
    };
    const cfg = {
      ...testConfig,
      backend,
      pageSize: { default: 15, max: 5 },
    };
    const response = await api(cfg)(
      new Request("https://owner.example/api/v1/notifications?limit=1000", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(capturedLimit).toBe(5);
  });
});
