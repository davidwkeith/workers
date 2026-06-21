import { describe, expect, it } from "vitest";

import { authenticate, bearerToken } from "./auth.js";
import { resolveConfig, type RemoteStorageConfig } from "./config.js";

// ---------------------------------------------------------------------------
// ES256 issuer fixtures
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signJwt(
  payload: Record<string, unknown>,
  key: CryptoKey,
  header: Record<string, unknown> = { alg: "ES256", typ: "JWT" },
): Promise<string> {
  const signingInput = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(
    enc.encode(JSON.stringify(payload)),
  )}`;
  const sig = await crypto.subtle.sign(SIGN, key, enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

const ISSUER = "https://issuer.example";

async function setup() {
  const pair = (await crypto.subtle.generateKey(ECDSA, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;
  const base: RemoteStorageConfig = {
    baseUrl: "https://storage.example",
    issuer: ISSUER,
    jwks: [jwk],
    now: () => 1_700_000_000_000,
  };
  return { privateKey: pair.privateKey, base };
}

function bearer(token: string): Request {
  return new Request("https://storage.example/alice/documents/x", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("bearerToken", () => {
  it("extracts a Bearer token case-insensitively", () => {
    const req = new Request("https://x", {
      headers: { authorization: "bearer abc.def.ghi" },
    });
    expect(bearerToken(req)).toBe("abc.def.ghi");
  });

  it("returns null without an Authorization header", () => {
    expect(bearerToken(new Request("https://x"))).toBeNull();
  });
});

describe("authenticate (built-in JWT verifier)", () => {
  it("is anonymous without credentials", async () => {
    const { base } = await setup();
    const result = await authenticate(
      new Request("https://storage.example/alice/public/x"),
      resolveConfig(base),
    );
    expect(result.kind).toBe("anonymous");
  });

  it("verifies a signed token and parses its scopes", async () => {
    const { privateKey, base } = await setup();
    const token = await signJwt(
      { iss: ISSUER, sub: "alice", exp: 1_700_000_900, scope: "documents:rw" },
      privateKey,
    );
    const result = await authenticate(bearer(token), resolveConfig(base));
    expect(result).toMatchObject({
      kind: "authenticated",
      auth: { scopes: [{ module: "documents", mode: "rw" }], subject: "alice" },
    });
  });

  it("rejects a token signed by an unknown key", async () => {
    const { base } = await setup();
    const other = (await crypto.subtle.generateKey(ECDSA, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const token = await signJwt(
      { iss: ISSUER, exp: 1_700_000_900, scope: "documents:rw" },
      other.privateKey,
    );
    const result = await authenticate(bearer(token), resolveConfig(base));
    expect(result).toEqual({ kind: "rejected", reason: "signature_invalid" });
  });

  it("rejects a wrong issuer and an expired token", async () => {
    const { privateKey, base } = await setup();
    const config = resolveConfig(base);

    const wrongIssuer = await signJwt(
      { iss: "https://evil.example", exp: 1_700_000_900 },
      privateKey,
    );
    expect(await authenticate(bearer(wrongIssuer), config)).toEqual({
      kind: "rejected",
      reason: "issuer_mismatch",
    });

    const expired = await signJwt(
      { iss: ISSUER, exp: 1_600_000_000 },
      privateKey,
    );
    expect(await authenticate(bearer(expired), config)).toEqual({
      kind: "rejected",
      reason: "token_expired",
    });
  });

  it("rejects an audience mismatch only when an audience is configured", async () => {
    const { privateKey, base } = await setup();
    const token = await signJwt(
      { iss: ISSUER, exp: 1_700_000_900, aud: "someone-else" },
      privateKey,
    );
    // No audience configured ⇒ aud is not checked.
    expect((await authenticate(bearer(token), resolveConfig(base))).kind).toBe(
      "authenticated",
    );
    // Audience configured and not matched ⇒ rejected.
    const withAud = resolveConfig({ ...base, audience: "storage.example" });
    expect(await authenticate(bearer(token), withAud)).toEqual({
      kind: "rejected",
      reason: "audience_mismatch",
    });
  });

  it("rejects a malformed token", async () => {
    const { base } = await setup();
    expect(
      await authenticate(bearer("not-a-jwt"), resolveConfig(base)),
    ).toEqual({ kind: "rejected", reason: "token_malformed" });
  });

  it("defers entirely to a custom authenticate hook when provided", async () => {
    const config = resolveConfig({
      baseUrl: "https://storage.example",
      authenticate: (request) =>
        request.headers.get("authorization") === "Bearer opaque"
          ? { scopes: [{ module: "contacts", mode: "r" }] }
          : null,
    });
    expect(await authenticate(bearer("opaque"), config)).toMatchObject({
      kind: "authenticated",
      auth: { scopes: [{ module: "contacts", mode: "r" }] },
    });
    expect((await authenticate(new Request("https://x"), config)).kind).toBe(
      "anonymous",
    );
  });
});
