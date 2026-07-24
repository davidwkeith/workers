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

  it("resolves in_reply_to_account_id to the owner id for a source-0 reply targeting the owner's post", async () => {
    await resetDb();
    const token = await obtainAccessToken();
    const id = encodeSnowflake(1_753_000_000_021, 1);
    // The fetched status is a source-0 (inbox) reply that targets the owner's
    // own post — the source-1 gate would have missed this.
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
              receivedAt: 1_753_000_000_021,
              objectType: "Note",
              relayedBy: null,
              source: 0,
              activity: {
                type: "Create",
                actor: "https://remote.example/users/alice",
                object: {
                  type: "Note",
                  content: "<p>re</p>",
                  inReplyTo: "https://owner.example/users/owner/posts/1",
                },
              },
              inReplyTo: {
                id: encodeSnowflake(1_753_000_000_001, 1, 1),
                authorIri: "https://owner.example/users/owner",
                authorIsOwner: true,
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
    const status = (await response.json()) as {
      in_reply_to_account_id: string;
    };
    expect(status.in_reply_to_account_id).toBe("1");
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
