import { describe, expect, it } from "vitest";

import { constantTimeEqual, signJwt, verifyJwt } from "./auth";

const SECRET = "test-secret";

function claims(extra: Partial<{ scope: string; exp: number }> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "did:web:alice.example",
    scope: extra.scope ?? "com.atproto.access",
    iat: now,
    exp: extra.exp ?? now + 3600,
  };
}

describe("session JWTs", () => {
  it("signs and verifies a token", async () => {
    const token = await signJwt(SECRET, claims());
    const verified = await verifyJwt(SECRET, token);
    expect(verified?.sub).toBe("did:web:alice.example");
    expect(verified?.scope).toBe("com.atproto.access");
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signJwt(SECRET, claims());
    expect(await verifyJwt("other-secret", token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signJwt(
      SECRET,
      claims({ exp: Math.floor(Date.now() / 1000) - 10 }),
    );
    expect(await verifyJwt(SECRET, token)).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await verifyJwt(SECRET, "not.a.jwt")).toBeNull();
    expect(await verifyJwt(SECRET, "onlyonepart")).toBeNull();
  });

  it("returns null (not a thrown error) for an invalid-base64 signature", async () => {
    const token = await signJwt(SECRET, claims());
    const [header, payload] = token.split(".");
    // `@@@@` is not valid base64url; the decode must be caught, not propagated.
    await expect(
      verifyJwt(SECRET, `${header}.${payload}.@@@@`),
    ).resolves.toBeNull();
  });
});

describe("constantTimeEqual", () => {
  it("matches equal strings and rejects different ones", async () => {
    expect(await constantTimeEqual("hunter2", "hunter2")).toBe(true);
    expect(await constantTimeEqual("hunter2", "hunter3")).toBe(false);
    expect(await constantTimeEqual("short", "a much longer secret")).toBe(
      false,
    );
  });
});
