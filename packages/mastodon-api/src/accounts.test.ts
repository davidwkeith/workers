import { beforeEach, describe, expect, it } from "vitest";

import type { MastodonApiConfig } from "./config.js";
import { sha256Hex } from "./encoding.js";
import { TRANSPARENT_PIXEL } from "./entities.js";
import { createMastodonStore } from "./store.js";
import {
  api,
  obtainAccessToken,
  resetDb,
  testConfig,
  testEnv,
} from "./test-harness.js";

function get(path: string, token?: string): Request {
  return new Request(`https://owner.example${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("bearer authentication", () => {
  beforeEach(resetDb);

  it("401s a missing bearer with Mastodon's error shape", async () => {
    const res = await api()(get("/api/v1/accounts/verify_credentials"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "The access token is invalid",
    });
  });

  it("401s a garbage bearer", async () => {
    const res = await api()(
      get("/api/v1/accounts/verify_credentials", "not-a-real-token"),
    );
    expect(res.status).toBe(401);
  });

  it("401s a revoked bearer", async () => {
    const token = await obtainAccessToken();
    expect(
      (await api()(get("/api/v1/accounts/verify_credentials", token))).status,
    ).toBe(200);
    await createMastodonStore(testEnv).revokeToken(await sha256Hex(token));
    const res = await api()(get("/api/v1/accounts/verify_credentials", token));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/accounts/verify_credentials", () => {
  beforeEach(resetDb);

  it("422s a client_credentials token (account required)", async () => {
    const token = await obtainAccessToken("client_credentials");
    const res = await api()(get("/api/v1/accounts/verify_credentials", token));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "This method requires an authenticated user.",
    });
  });

  it("renders the owner CredentialAccount with zero counts", async () => {
    const token = await obtainAccessToken();
    const res = await api()(get("/api/v1/accounts/verify_credentials", token));
    expect(res.status).toBe(200);
    const account = (await res.json()) as Record<string, unknown>;
    expect(account["id"]).toBe("1");
    expect(account["username"]).toBe("owner");
    expect(account["acct"]).toBe("owner");
    expect(account["display_name"]).toBe("owner");
    expect(account["url"]).toBe("https://owner.example/users/owner");
    expect(account["avatar"]).toBe(TRANSPARENT_PIXEL);
    expect(account["followers_count"]).toBe(0);
    expect(account["following_count"]).toBe(0);
    expect(account["statuses_count"]).toBe(0);
    expect(account["source"]).toMatchObject({ privacy: "public" });
  });

  it("uses live backend counts when a backend is configured", async () => {
    const token = await obtainAccessToken();
    const withBackend: MastodonApiConfig = {
      ...testConfig,
      backend: {
        account: async () => ({
          counts: { followers: 2, following: 3, statuses: 5 },
        }),
        timeline: async () => ({ entries: [] }),
        notifications: async () => ({ entries: [] }),
        entry: async () => null,
      },
    };
    const res = await api(withBackend)(
      get("/api/v1/accounts/verify_credentials", token),
    );
    const account = (await res.json()) as Record<string, unknown>;
    expect(account["followers_count"]).toBe(2);
    expect(account["following_count"]).toBe(3);
    expect(account["statuses_count"]).toBe(5);
  });
});

describe("GET /api/v1/apps/verify_credentials", () => {
  beforeEach(resetDb);

  it("accepts a client_credentials token and returns the app sans secrets", async () => {
    const token = await obtainAccessToken("client_credentials");
    const res = await api()(get("/api/v1/apps/verify_credentials", token));
    expect(res.status).toBe(200);
    const app = (await res.json()) as Record<string, unknown>;
    expect(app["name"]).toBe("Tusky");
    expect(app).not.toHaveProperty("client_secret");
    expect(app).not.toHaveProperty("vapid_key");
  });

  it("401s without a token", async () => {
    const res = await api()(get("/api/v1/apps/verify_credentials"));
    expect(res.status).toBe(401);
  });
});
