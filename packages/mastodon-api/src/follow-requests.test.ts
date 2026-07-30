import { describe, expect, it } from "vitest";

import { api, registerApp, resetDb, testConfig } from "./test-harness.js";
import type { BackendFollowRequest, MastodonBackend } from "./backend.js";
import { encodeRemoteAccountId } from "./entities.js";

const REMOTE = "https://remote.example/users/alice";

function readBackend(
  rows: readonly BackendFollowRequest[] = [],
): MastodonBackend {
  return {
    account: async () => ({
      counts: { followers: 0, following: 0, statuses: 0 },
    }),
    timeline: async () => ({ entries: [] }),
    notifications: async () => ({ entries: [] }),
    entry: async () => null,
    followRequests: async () => rows,
  };
}

function writeBackend(
  rows: readonly BackendFollowRequest[] = [],
): MastodonBackend & {
  readonly responses: { actor: string; action: "authorize" | "reject" }[];
} {
  const responses: { actor: string; action: "authorize" | "reject" }[] = [];
  return {
    ...readBackend(rows),
    responses,
    respondToFollowRequest: async (actor, action) => {
      responses.push({ actor, action });
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

describe("GET /api/v1/follow_requests", () => {
  it("200s an empty array with no backend method", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const cfg = { ...testConfig, backend: readBackend() };
    delete (cfg.backend as Partial<MastodonBackend>).followRequests;
    const res = await api(cfg)(
      new Request("https://owner.example/api/v1/follow_requests", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("maps pending rows through remoteAccountEntity", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const cfg = {
      ...testConfig,
      backend: readBackend([{ actor: REMOTE, addedAt: 123 }]),
    };
    const res = await api(cfg)(
      new Request("https://owner.example/api/v1/follow_requests", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const accounts = (await res.json()) as { id: string }[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.id).toBe(encodeRemoteAccountId(REMOTE));
  });

  it("401s without a bearer token", async () => {
    await resetDb();
    const cfg = { ...testConfig, backend: readBackend() };
    const res = await api(cfg)(
      new Request("https://owner.example/api/v1/follow_requests"),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/follow_requests/:id/authorize|reject", () => {
  it("404s when writes are not enabled", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const cfg = { ...testConfig, backend: writeBackend() }; // allowWrites defaults false
    const res = await api(cfg)(
      new Request(
        `https://owner.example/api/v1/follow_requests/${encodeRemoteAccountId(REMOTE)}/authorize`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("404s when writes are enabled but the backend cannot respond", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const cfg = { ...testConfig, allowWrites: true, backend: readBackend() };
    const res = await api(cfg)(
      new Request(
        `https://owner.example/api/v1/follow_requests/${encodeRemoteAccountId(REMOTE)}/authorize`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("403s a read-only token", async () => {
    await resetDb();
    const token = await tokenWithScopes("read");
    const cfg = { ...testConfig, allowWrites: true, backend: writeBackend() };
    const res = await api(cfg)(
      new Request(
        `https://owner.example/api/v1/follow_requests/${encodeRemoteAccountId(REMOTE)}/authorize`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("404s an undecodable id", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const cfg = { ...testConfig, allowWrites: true, backend: writeBackend() };
    const res = await api(cfg)(
      new Request(
        "https://owner.example/api/v1/follow_requests/not-a-valid-id/authorize",
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(404);
  });

  it("authorizes: calls the backend and returns a Relationship with followed_by:true", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const backend = writeBackend();
    const cfg = { ...testConfig, allowWrites: true, backend };
    const res = await api(cfg)(
      new Request(
        `https://owner.example/api/v1/follow_requests/${encodeRemoteAccountId(REMOTE)}/authorize`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(200);
    expect(backend.responses).toEqual([{ actor: REMOTE, action: "authorize" }]);
    const relationship = (await res.json()) as { followed_by: boolean };
    expect(relationship.followed_by).toBe(true);
  });

  it("rejects: calls the backend and returns a Relationship with followed_by:false", async () => {
    await resetDb();
    const token = await tokenWithScopes("read write");
    const backend = writeBackend();
    const cfg = { ...testConfig, allowWrites: true, backend };
    const res = await api(cfg)(
      new Request(
        `https://owner.example/api/v1/follow_requests/${encodeRemoteAccountId(REMOTE)}/reject`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(200);
    expect(backend.responses).toEqual([{ actor: REMOTE, action: "reject" }]);
    const relationship = (await res.json()) as { followed_by: boolean };
    expect(relationship.followed_by).toBe(false);
  });
});
