import { describe, expect, it } from "vitest";

import {
  createDpopBearerAuthenticator,
  McpAuthError,
  tokenFromAuthHeader,
  type DpopReplayStore,
  type IntrospectedToken,
} from "./auth.js";

// ---------------------------------------------------------------------------
// Test helpers: craft real, signed DPoP proofs with Web Crypto (same approach
// as @dwk/dpop's own suite) so this exercises the actual verification path,
// not a mock.
// ---------------------------------------------------------------------------

const HTU = "https://example.com/mcp";
const NOW = 1_700_000_000;
const TOKEN = "opaque-access-token";

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function textToBase64url(text: string): string {
  return bytesToBase64url(new TextEncoder().encode(text));
}

async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return bytesToBase64url(new Uint8Array(digest));
}

interface KeyMaterial {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

async function makeKey(): Promise<KeyMaterial> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;
  return { privateKey: pair.privateKey, publicJwk };
}

interface ProofOptions {
  htm?: string;
  htu?: string;
  iat?: number;
  jti?: string;
  accessToken?: string;
}

async function makeProof(
  key: KeyMaterial,
  opts: ProofOptions = {},
): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk };
  const payload: Record<string, unknown> = {
    htm: opts.htm ?? "POST",
    htu: opts.htu ?? HTU,
    iat: opts.iat ?? NOW,
    jti: opts.jti ?? "unique-id-123",
  };
  if (opts.accessToken !== undefined) {
    payload.ath = await sha256Base64url(opts.accessToken);
  }
  const headerSeg = textToBase64url(JSON.stringify(header));
  const payloadSeg = textToBase64url(JSON.stringify(payload));
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${bytesToBase64url(signature)}`;
}

/** RFC 7638 thumbprint for a P-256 public JWK, computed independently of `@dwk/dpop`. */
async function thumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  return sha256Base64url(canonical);
}

function inMemoryReplayStore(): DpopReplayStore {
  const seen = new Map<string, number>();
  return {
    async recordProof(jti, expiresAt, now) {
      for (const [key, exp] of seen) if (exp <= now) seen.delete(key);
      if (seen.has(jti)) return false;
      seen.set(jti, expiresAt);
      return true;
    },
  };
}

function request(headers: Record<string, string> = {}): Request {
  return new Request(HTU, { method: "POST", headers });
}

describe("tokenFromAuthHeader", () => {
  it("extracts a DPoP-scheme token", () => {
    const req = request({ Authorization: "DPoP abc.def.ghi" });
    expect(tokenFromAuthHeader(req)).toBe("abc.def.ghi");
  });

  it("extracts a legacy Bearer-scheme token", () => {
    const req = request({ Authorization: "Bearer abc.def.ghi" });
    expect(tokenFromAuthHeader(req)).toBe("abc.def.ghi");
  });

  it("returns null when the header is absent", () => {
    expect(tokenFromAuthHeader(request())).toBeNull();
  });

  it("returns null when the scheme is unrecognized", () => {
    const req = request({ Authorization: "Basic dXNlcjpwYXNz" });
    expect(tokenFromAuthHeader(req)).toBeNull();
  });
});

describe("createDpopBearerAuthenticator", () => {
  it("throws when no Authorization header is present", async () => {
    const authenticate = createDpopBearerAuthenticator({
      introspectToken: async () => null,
      replayStore: inMemoryReplayStore(),
      now: () => NOW,
    });
    await expect(authenticate(request())).rejects.toThrow(McpAuthError);
  });

  it("throws when the token is unknown", async () => {
    const authenticate = createDpopBearerAuthenticator({
      introspectToken: async () => null,
      replayStore: inMemoryReplayStore(),
      now: () => NOW,
    });
    await expect(
      authenticate(request({ Authorization: `DPoP ${TOKEN}` })),
    ).rejects.toThrow(McpAuthError);
  });

  it("throws when the token is inactive", async () => {
    const authenticate = createDpopBearerAuthenticator({
      introspectToken: async () => ({ active: false }),
      replayStore: inMemoryReplayStore(),
      now: () => NOW,
    });
    await expect(
      authenticate(request({ Authorization: `DPoP ${TOKEN}` })),
    ).rejects.toThrow(McpAuthError);
  });

  it("throws when the active token carries no cnf.jkt (not DPoP-bound)", async () => {
    const authenticate = createDpopBearerAuthenticator({
      introspectToken: async () => ({ active: true, scope: "publish" }),
      replayStore: inMemoryReplayStore(),
      now: () => NOW,
    });
    await expect(
      authenticate(request({ Authorization: `DPoP ${TOKEN}` })),
    ).rejects.toThrow(McpAuthError);
  });

  it("throws when the token is active and DPoP-bound but no DPoP proof is sent", async () => {
    const key = await makeKey();
    const jkt = await thumbprint(key.publicJwk);
    const authenticate = createDpopBearerAuthenticator({
      introspectToken: async () => ({ active: true, cnf: { jkt } }),
      replayStore: inMemoryReplayStore(),
      now: () => NOW,
    });
    await expect(
      authenticate(request({ Authorization: `DPoP ${TOKEN}` })),
    ).rejects.toThrow(McpAuthError);
  });

  it("throws when the DPoP proof is invalid (wrong key, jkt mismatch)", async () => {
    const key = await makeKey();
    const otherKey = await makeKey();
    const jkt = await thumbprint(key.publicJwk);
    const proof = await makeProof(otherKey, { accessToken: TOKEN });
    const authenticate = createDpopBearerAuthenticator({
      introspectToken: async () => ({ active: true, cnf: { jkt } }),
      replayStore: inMemoryReplayStore(),
      now: () => NOW,
    });
    await expect(
      authenticate(request({ Authorization: `DPoP ${TOKEN}`, DPoP: proof })),
    ).rejects.toThrow(McpAuthError);
  });

  it("throws on a replayed proof jti", async () => {
    const key = await makeKey();
    const jkt = await thumbprint(key.publicJwk);
    const proof = await makeProof(key, { accessToken: TOKEN });
    const authenticate = createDpopBearerAuthenticator({
      introspectToken: async () => ({ active: true, cnf: { jkt } }),
      replayStore: inMemoryReplayStore(),
      now: () => NOW,
    });
    const first = request({ Authorization: `DPoP ${TOKEN}`, DPoP: proof });
    const second = request({ Authorization: `DPoP ${TOKEN}`, DPoP: proof });
    await expect(authenticate(first)).resolves.toBeDefined();
    await expect(authenticate(second)).rejects.toThrow(McpAuthError);
  });

  it("succeeds and returns the granted scopes + subject", async () => {
    const key = await makeKey();
    const jkt = await thumbprint(key.publicJwk);
    const proof = await makeProof(key, { accessToken: TOKEN });
    const record: IntrospectedToken = {
      active: true,
      scope: "microsub:read create",
      sub: "https://me.example/",
      cnf: { jkt },
    };
    const authenticate = createDpopBearerAuthenticator({
      introspectToken: async (token) => {
        expect(token).toBe(TOKEN);
        return record;
      },
      replayStore: inMemoryReplayStore(),
      now: () => NOW,
    });
    const auth = await authenticate(
      request({ Authorization: `DPoP ${TOKEN}`, DPoP: proof }),
    );
    expect(auth.scopes).toEqual(["microsub:read", "create"]);
    expect(auth.subject).toBe("https://me.example/");
  });

  it("grants no scopes when the token record carries an empty scope string", async () => {
    const key = await makeKey();
    const jkt = await thumbprint(key.publicJwk);
    const proof = await makeProof(key, { accessToken: TOKEN });
    const authenticate = createDpopBearerAuthenticator({
      introspectToken: async () => ({ active: true, cnf: { jkt } }),
      replayStore: inMemoryReplayStore(),
      now: () => NOW,
    });
    const auth = await authenticate(
      request({ Authorization: `DPoP ${TOKEN}`, DPoP: proof }),
    );
    expect(auth.scopes).toEqual([]);
  });
});
