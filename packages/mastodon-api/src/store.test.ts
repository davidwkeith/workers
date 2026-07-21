import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { ClientRecord } from "@dwk/oauth";

import type { MastodonApiEnv } from "./config.js";
import { createMastodonStore } from "./store.js";

const testEnv = env as unknown as MastodonApiEnv;

function appRecord(id = "client-1"): ClientRecord {
  return {
    clientId: id,
    clientIdIssuedAt: 1_700_000_000,
    clientSecret: "sha256-of-secret",
    metadata: {
      client_name: "Tusky",
      redirect_uris: ["app://oauth-callback"],
      scope: "read write follow push",
      client_uri: "https://tusky.app",
    },
  };
}

describe("createMastodonStore", () => {
  beforeEach(async () => {
    for (const table of [
      "mastodon_apps",
      "mastodon_codes",
      "mastodon_tokens",
      "mastodon_markers",
    ]) {
      await testEnv.AUTH_DB.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  });

  it("fails loudly without AUTH_DB", () => {
    expect(() => createMastodonStore({} as MastodonApiEnv)).toThrow(/AUTH_DB/);
  });

  it("round-trips apps as ClientRecords", async () => {
    const store = createMastodonStore(testEnv);
    await store.saveClient(appRecord());
    expect(await store.getClient("client-1")).toEqual(appRecord());
    expect(await store.getClient("missing")).toBeNull();
  });

  it("prunes stale never-authorized apps on save, keeping authorized ones", async () => {
    const store = createMastodonStore(testEnv);
    // Two ancient apps, one with an issued token, one without.
    const ancient = 1_000;
    await store.saveClient({
      ...appRecord("stale"),
      clientIdIssuedAt: ancient,
    });
    await store.saveClient({
      ...appRecord("authorized"),
      clientIdIssuedAt: ancient,
    });
    await store.saveToken({
      tokenHash: "hash-x",
      clientId: "authorized",
      scope: "read",
      accountId: "1",
      createdAt: ancient,
      revoked: false,
    });
    // A fresh registration triggers the sweep (now >> ancient + 30 days).
    await store.saveClient(appRecord("fresh"));
    expect(await store.getClient("stale")).toBeNull();
    expect(await store.getClient("authorized")).not.toBeNull();
    expect(await store.getClient("fresh")).not.toBeNull();
  });

  it("redeems a code exactly once and never after expiry", async () => {
    const store = createMastodonStore(testEnv);
    const record = {
      code: "code-1",
      clientId: "client-1",
      redirectUri: "app://oauth-callback",
      scope: "read",
      codeChallenge: null,
      expiresAt: 2_000,
    };
    await store.saveCode(record);
    expect(await store.redeemCode("code-1", 1_000)).toEqual(record);
    expect(await store.redeemCode("code-1", 1_000)).toBeNull(); // single-use
    await store.saveCode({ ...record, code: "code-2" });
    expect(await store.redeemCode("code-2", 3_000)).toBeNull(); // expired
  });

  it("stores, reads, and revokes tokens by hash", async () => {
    const store = createMastodonStore(testEnv);
    const record = {
      tokenHash: "hash-1",
      clientId: "client-1",
      scope: "read",
      accountId: "1",
      createdAt: 1_000,
      revoked: false,
    };
    await store.saveToken(record);
    expect(await store.getToken("hash-1")).toEqual(record);
    await store.revokeToken("hash-1");
    expect((await store.getToken("hash-1"))?.revoked).toBe(true);
    await store.revokeToken("unknown"); // idempotent no-op
  });

  it("stores account-less (client_credentials) tokens", async () => {
    const store = createMastodonStore(testEnv);
    await store.saveToken({
      tokenHash: "hash-cc",
      clientId: "client-1",
      scope: "read",
      accountId: null,
      createdAt: 1_000,
      revoked: false,
    });
    expect((await store.getToken("hash-cc"))?.accountId).toBeNull();
  });

  it("upserts markers with version increments", async () => {
    const store = createMastodonStore(testEnv);
    const first = await store.saveMarker("home", "101", 1_000);
    expect(first).toEqual({
      timeline: "home",
      lastReadId: "101",
      version: 1,
      updatedAt: 1_000,
    });
    const second = await store.saveMarker("home", "202", 2_000);
    expect(second.version).toBe(2);
    expect(await store.getMarkers(["home", "notifications"])).toEqual([
      { timeline: "home", lastReadId: "202", version: 2, updatedAt: 2_000 },
    ]);
  });
});
