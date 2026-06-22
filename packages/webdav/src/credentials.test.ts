import { describe, expect, it } from "vitest";
import {
  generateCredentialId,
  generateSecret,
  isHttpsRequest,
  mintAppPassword,
  parseBasicAuthorization,
  timingSafeEqual,
  verifyAppPassword,
  type AppPasswordScope,
} from "./credentials.js";

// Keep PBKDF2 cheap in tests; production uses DEFAULT_PBKDF2_ITERATIONS.
const ITERATIONS = 1_000;
const SCOPE: AppPasswordScope = { modes: ["read", "write"] };

describe("credential id and secret generation", () => {
  it("mints colon-free credential ids (Basic splits on the first colon)", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateCredentialId()).not.toContain(":");
    }
  });

  it("mints high-entropy, distinct secrets", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toContain(":");
  });
});

describe("mintAppPassword / verifyAppPassword", () => {
  it("binds a WebID, never persists the plaintext, and verifies the secret", async () => {
    const minted = await mintAppPassword({
      webid: "https://me.example/profile#me",
      label: "MacBook Finder",
      scope: SCOPE,
      iterations: ITERATIONS,
    });

    expect(minted.username).toBe(minted.record.credentialId);
    expect(minted.record.webid).toBe("https://me.example/profile#me");
    // The record stores only a salted hash, never the secret.
    expect(JSON.stringify(minted.record)).not.toContain(minted.secret);
    expect(minted.record.hashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.record.saltHex).toMatch(/^[0-9a-f]{32}$/);

    expect(await verifyAppPassword(minted.secret, minted.record)).toBe(true);
    expect(await verifyAppPassword("wrong-secret", minted.record)).toBe(false);
  });

  it("rejects an expired credential", async () => {
    let clock = 1_000;
    const minted = await mintAppPassword({
      webid: "https://me.example/#me",
      label: "temp",
      scope: SCOPE,
      iterations: ITERATIONS,
      expiresAt: 2_000,
      now: () => clock,
    });
    expect(
      await verifyAppPassword(minted.secret, minted.record, () => 1_500),
    ).toBe(true);
    clock = 5_000;
    expect(
      await verifyAppPassword(minted.secret, minted.record, () => clock),
    ).toBe(false);
  });

  it("never matches a secret against a different record's hash", async () => {
    const a = await mintAppPassword({
      webid: "https://a.example/#me",
      label: "a",
      scope: SCOPE,
      iterations: ITERATIONS,
    });
    const b = await mintAppPassword({
      webid: "https://b.example/#me",
      label: "b",
      scope: SCOPE,
      iterations: ITERATIONS,
    });
    expect(await verifyAppPassword(a.secret, b.record)).toBe(false);
  });
});

describe("timingSafeEqual", () => {
  it("compares equal-length byte arrays", () => {
    expect(
      timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])),
    ).toBe(true);
    expect(
      timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])),
    ).toBe(false);
  });

  it("returns false for differing lengths", () => {
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(
      false,
    );
  });
});

describe("parseBasicAuthorization", () => {
  it("decodes a Basic credential, splitting on the first colon", () => {
    // "wdav-abc:s3cr:et" — a password containing a colon must survive.
    const header = `Basic ${btoa("wdav-abc:s3cr:et")}`;
    expect(parseBasicAuthorization(header)).toEqual({
      username: "wdav-abc",
      password: "s3cr:et",
    });
  });

  it("is scheme case-insensitive", () => {
    expect(parseBasicAuthorization(`basic ${btoa("u:p")}`)).toEqual({
      username: "u",
      password: "p",
    });
  });

  it("decodes UTF-8 credentials", () => {
    const bytes = new TextEncoder().encode("user:pä55");
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    expect(parseBasicAuthorization(`Basic ${btoa(binary)}`)).toEqual({
      username: "user",
      password: "pä55",
    });
  });

  it("returns null for non-Basic, malformed, or colon-less input", () => {
    expect(parseBasicAuthorization(null)).toBeNull();
    expect(parseBasicAuthorization("Bearer xyz")).toBeNull();
    expect(parseBasicAuthorization("Basic !!!not-base64!!!")).toBeNull();
    expect(parseBasicAuthorization(`Basic ${btoa("no-colon")}`)).toBeNull();
  });
});

describe("isHttpsRequest", () => {
  it("accepts https and rejects everything else", () => {
    expect(isHttpsRequest("https://pod.example/dav/")).toBe(true);
    expect(isHttpsRequest("http://pod.example/dav/")).toBe(false);
    expect(isHttpsRequest("not a url")).toBe(false);
  });
});
