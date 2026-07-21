import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createIndieAuthStore, type IndieAuthStoreEnv } from "./store.js";

/**
 * Fresh-deploy regression: the store must materialise its own schema lazily, so
 * a consumer that composes `@dwk/indieauth` against a brand-new D1 (without
 * running a separate migration step) does not 500 on the first authorization or
 * token request. Each test file gets isolated D1 storage, so these operations
 * run against an empty database with no `init()` call.
 */

const harness = env as unknown as IndieAuthStoreEnv;

describe("lazy schema on a fresh D1 (no init)", () => {
  it("saves and redeems an authorization code without a prior init()", async () => {
    const store = createIndieAuthStore(harness);
    await store.saveAuthorizationCode({
      code: "code-1",
      clientId: "https://app.example/",
      redirectUri: "https://app.example/cb",
      scope: "create",
      me: "https://me.example/",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      profile: null,
      expiresAt: 9_999_999_999,
    });
    const redeemed = await store.redeemAuthorizationCode("code-1", 1);
    expect(redeemed?.clientId).toBe("https://app.example/");
  });

  it("records and reads back a token without a prior init()", async () => {
    const store = createIndieAuthStore(harness);
    await store.recordToken({
      jti: "token-1",
      clientId: "https://app.example/",
      me: "https://me.example/",
      scope: "create",
      jkt: "thumbprint",
      issuedAt: 1,
      expiresAt: 9_999_999_999,
    });
    expect(await store.isTokenActive("token-1", 2)).toBe(true);
  });
});

describe("opportunistic reaping of expired rows (#313)", () => {
  it("prunes an already-expired authorization code on the next save", async () => {
    const store = createIndieAuthStore(harness);
    await store.saveAuthorizationCode({
      code: "expired-code",
      clientId: "https://app.example/",
      redirectUri: "https://app.example/cb",
      scope: "create",
      me: "https://me.example/",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      profile: null,
      expiresAt: 1, // long past relative to real Date.now()
    });
    // Any subsequent save opportunistically reaps expired rows.
    await store.saveAuthorizationCode({
      code: "fresh-code",
      clientId: "https://app.example/",
      redirectUri: "https://app.example/cb",
      scope: "create",
      me: "https://me.example/",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      profile: null,
      expiresAt: 9_999_999_999,
    });
    const rows = await harness.AUTH_DB.prepare(
      "SELECT code FROM authorization_codes",
    ).all<{ code: string }>();
    const codes = rows.results.map((r) => r.code);
    expect(codes).not.toContain("expired-code");
    expect(codes).toContain("fresh-code");
  });

  it("prunes an already-expired access token on the next recordToken", async () => {
    const store = createIndieAuthStore(harness);
    await store.recordToken({
      jti: "expired-token",
      clientId: "https://app.example/",
      me: "https://me.example/",
      scope: "create",
      jkt: "thumbprint",
      issuedAt: 1,
      expiresAt: 1, // long past relative to real Date.now()
    });
    // Any subsequent recordToken opportunistically reaps expired rows.
    await store.recordToken({
      jti: "fresh-token",
      clientId: "https://app.example/",
      me: "https://me.example/",
      scope: "create",
      jkt: "thumbprint",
      issuedAt: 1,
      expiresAt: 9_999_999_999,
    });
    const rows = await harness.AUTH_DB.prepare(
      "SELECT jti FROM access_tokens",
    ).all<{ jti: string }>();
    const jtis = rows.results.map((r) => r.jti);
    expect(jtis).not.toContain("expired-token");
    expect(jtis).toContain("fresh-token");
  });
});
