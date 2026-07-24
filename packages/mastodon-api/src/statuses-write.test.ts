import { describe, expect, it } from "vitest";

import { api, registerApp, resetDb, testConfig } from "./test-harness.js";
import type {
  BackendEntry,
  BackendPublishInput,
  MastodonBackend,
} from "./backend.js";
import { encodeSnowflake } from "./snowflake.js";

/** A backend that records the publish input and echoes back a source-1 entry. */
function writeBackend(): MastodonBackend & {
  readonly published: BackendPublishInput[];
} {
  const published: BackendPublishInput[] = [];
  return {
    published,
    account: async () => ({
      counts: { followers: 1, following: 2, statuses: 3 },
    }),
    timeline: async () => ({ entries: [] }),
    notifications: async () => ({ entries: [] }),
    entry: async () => null,
    publishStatus: async (input): Promise<BackendEntry> => {
      published.push(input);
      return {
        id: encodeSnowflake(1_753_000_000_100, 1, 1),
        receivedAt: 1_753_000_000_100,
        objectType: "Note",
        relayedBy: null,
        source: 1,
        activity: {
          type: "Create",
          actor: "https://owner.example/users/owner",
          object: {
            id: "https://owner.example/users/owner/outbox/x/object",
            type: "Note",
            content: `<p>${input.status}</p>`,
            ...(input.spoilerText ? { summary: input.spoilerText } : {}),
            ...(input.sensitive ? { sensitive: input.sensitive } : {}),
          },
        },
      };
    },
  };
}

/** Mint a bearer token whose grant carries exactly `scopes`. */
async function tokenWithScopes(scopes: string): Promise<string> {
  const app = await registerApp({ scopes });
  const authorize = new URL("https://owner.example/oauth/authorize");
  authorize.searchParams.set("client_id", app.client_id);
  authorize.searchParams.set("redirect_uri", "app://oauth-callback");
  authorize.searchParams.set("response_type", "code");
  const redirect = await api()(new Request(authorize.toString()));
  const code = new URL(redirect.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  const res = await api()(
    new Request("https://owner.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: app.client_id,
        client_secret: app.client_secret,
        redirect_uri: "app://oauth-callback",
        code: code ?? "",
      }),
    }),
  );
  return ((await res.json()) as { access_token: string }).access_token;
}

function post(token: string, body: string): Request {
  return new Request("https://owner.example/api/v1/statuses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

describe("POST /api/v1/statuses", () => {
  it("404s when writes are not enabled (default keeps the API read-only)", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    // allowWrites defaults to false on testConfig.
    const cfg = { ...testConfig, backend: writeBackend() };
    const response = await api(cfg)(post(token, "status=hello"));
    expect(response.status).toBe(404);
  });

  it("404s when writes are enabled but the backend cannot publish", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const backend: MastodonBackend = {
      account: async () => ({
        counts: { followers: 0, following: 0, statuses: 0 },
      }),
      timeline: async () => ({ entries: [] }),
      notifications: async () => ({ entries: [] }),
      entry: async () => null,
    };
    const cfg = { ...testConfig, allowWrites: true, backend };
    const response = await api(cfg)(post(token, "status=hello"));
    expect(response.status).toBe(404);
  });

  it("401s without a bearer token", async () => {
    await resetDb();
    const cfg = { ...testConfig, allowWrites: true, backend: writeBackend() };
    const response = await api(cfg)(
      new Request("https://owner.example/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "status=hi",
      }),
    );
    expect(response.status).toBe(401);
  });

  it("403s a read-only token (insufficient scope)", async () => {
    await resetDb();
    const token = await tokenWithScopes("read");
    const cfg = { ...testConfig, allowWrites: true, backend: writeBackend() };
    const response = await api(cfg)(post(token, "status=hi"));
    expect(response.status).toBe(403);
  });

  it("422s a blank status", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const cfg = { ...testConfig, allowWrites: true, backend: writeBackend() };
    const response = await api(cfg)(post(token, "status=%20%20"));
    expect(response.status).toBe(422);
  });

  it("422s a status over the 500-character ceiling", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const cfg = { ...testConfig, allowWrites: true, backend: writeBackend() };
    const long = "x".repeat(501);
    const response = await api(cfg)(post(token, `status=${long}`));
    expect(response.status).toBe(422);
  });

  it("publishes a status and returns the owner-attributed Status", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const backend = writeBackend();
    const cfg = { ...testConfig, allowWrites: true, backend };
    const response = await api(cfg)(
      post(token, "status=hello%20world&spoiler_text=cw&sensitive=true"),
    );
    expect(response.status).toBe(200);
    const status = (await response.json()) as {
      content: string;
      spoiler_text: string;
      sensitive: boolean;
      account: { id: string };
    };
    expect(backend.published).toEqual([
      { status: "hello world", spoilerText: "cw", sensitive: true },
    ]);
    expect(status.content).toContain("hello world");
    expect(status.spoiler_text).toBe("cw");
    expect(status.sensitive).toBe(true);
    // Owner-authored (source 1) → the real owner account id, not a remote one.
    expect(status.account.id).toBe("1");
  });

  it("accepts a client_credentials (app-level) token only up to the account gate", async () => {
    await resetDb();
    // An app-level token has no account, so writes are 422 (account required)
    // even with write scope — matching the read account endpoints.
    const app = await registerApp({ scopes: "read write" });
    const tokenRes = await api()(
      new Request("https://owner.example/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: app.client_id,
          client_secret: app.client_secret,
        }),
      }),
    );
    const token = ((await tokenRes.json()) as { access_token: string })
      .access_token;
    const cfg = { ...testConfig, allowWrites: true, backend: writeBackend() };
    const response = await api(cfg)(post(token, "status=hi"));
    expect(response.status).toBe(422);
  });
});
