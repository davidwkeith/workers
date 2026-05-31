import { describe, expect, it } from "vitest";

import {
  canonicalizeProfileUrl,
  isSupportedChallengeMethod,
  parseRelMeLinks,
  relMeLinksBack,
  signAccessToken,
  verifyAccessToken,
  verifyPkce,
} from "./index";

const SECRET = "unit-test-secret";

describe("PKCE", () => {
  it("verifies a correct S256 verifier and rejects a wrong one", async () => {
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"; // 43 chars
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const bytes = new Uint8Array(digest);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const challenge = btoa(bin)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(await verifyPkce(verifier, challenge, "S256")).toBe(true);
    expect(await verifyPkce("x".repeat(43), challenge, "S256")).toBe(false);
  });

  it("rejects unsupported methods and malformed verifiers", async () => {
    expect(isSupportedChallengeMethod("S256")).toBe(true);
    expect(isSupportedChallengeMethod("plain")).toBe(false);
    expect(await verifyPkce("short", "challenge", "S256")).toBe(false);
    expect(await verifyPkce("a".repeat(43), "challenge", "plain")).toBe(false);
  });
});

describe("profile URL canonicalization", () => {
  it("canonicalizes and validates", () => {
    expect(canonicalizeProfileUrl("https://example.com")).toBe(
      "https://example.com/",
    );
    expect(canonicalizeProfileUrl("https://example.com/users/alice")).toBe(
      "https://example.com/users/alice",
    );
  });

  it("rejects fragments, credentials, ports, IPs, and dot segments", () => {
    expect(canonicalizeProfileUrl("https://example.com/#me")).toBeNull();
    expect(canonicalizeProfileUrl("https://user:pw@example.com/")).toBeNull();
    expect(canonicalizeProfileUrl("https://example.com:8443/")).toBeNull();
    expect(canonicalizeProfileUrl("https://127.0.0.1/")).toBeNull();
    expect(canonicalizeProfileUrl("https://example.com/../x")).toBeNull();
    expect(canonicalizeProfileUrl("mailto:a@example.com")).toBeNull();
  });
});

describe("rel=me discovery", () => {
  const html = `
    <a rel="me" href="https://github.com/alice">gh</a>
    <link rel="me authn" href="/mastodon" />
    <a rel="nofollow" href="https://other.example/">no</a>
  `;

  it("extracts and resolves rel=me links", () => {
    const links = parseRelMeLinks(html, "https://alice.example.com/");
    expect(links).toContain("https://github.com/alice");
    expect(links).toContain("https://alice.example.com/mastodon");
    expect(links).not.toContain("https://other.example/");
  });

  it("ignores commented-out links and hyphenated attribute names", () => {
    const tricky = `
      <!-- <a rel="me" href="https://evil.example/">hidden</a> -->
      <a data-rel="me" data-href="https://decoy.example/">decoy</a>
      <a rel="me" href="https://real.example/">real</a>
    `;
    const links = parseRelMeLinks(tricky, "https://alice.example.com/");
    expect(links).toEqual(["https://real.example/"]);
  });

  it("supports unquoted href values", () => {
    const links = parseRelMeLinks(
      `<a rel=me href=https://unquoted.example/>x</a>`,
      "https://alice.example.com/",
    );
    expect(links).toContain("https://unquoted.example/");
  });

  it("confirms a back-link", () => {
    const back = `<a rel="me" href="https://alice.example.com">me</a>`;
    expect(
      relMeLinksBack(
        back,
        "https://github.com/alice",
        "https://alice.example.com/",
      ),
    ).toBe(true);
    expect(
      relMeLinksBack(
        back,
        "https://github.com/alice",
        "https://bob.example.com/",
      ),
    ).toBe(false);
  });
});

describe("access token sign/verify", () => {
  it("round-trips claims and binds cnf.jkt", async () => {
    const { token, claims } = await signAccessToken(SECRET, {
      issuer: "https://example.com",
      me: "https://alice.example.com/",
      clientId: "https://app.example/",
      scope: "create",
      jkt: "thumbprint-123",
      lifetimeSeconds: 3600,
    });
    const result = await verifyAccessToken(token, SECRET, {
      issuer: "https://example.com",
    });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.claims.cnf.jkt).toBe("thumbprint-123");
    expect(result.claims.jti).toBe(claims.jti);
    expect(result.claims.scope).toBe("create");
  });

  it("rejects a tampered signature, wrong issuer, and expiry", async () => {
    const { token } = await signAccessToken(SECRET, {
      issuer: "https://example.com",
      me: "https://alice.example.com/",
      clientId: "https://app.example/",
      scope: "create",
      jkt: "jkt",
      lifetimeSeconds: 3600,
      now: 1000,
    });
    expect(
      (
        await verifyAccessToken(token, "wrong-secret", {
          issuer: "https://example.com",
        })
      ).valid,
    ).toBe(false);
    expect(
      (await verifyAccessToken(token, SECRET, { issuer: "https://other.com" }))
        .valid,
    ).toBe(false);
    const expired = await verifyAccessToken(token, SECRET, {
      issuer: "https://example.com",
      now: 1000 + 3600,
    });
    expect(expired.valid).toBe(false);
    if (!expired.valid) expect(expired.reason).toBe("expired");
  });
});
