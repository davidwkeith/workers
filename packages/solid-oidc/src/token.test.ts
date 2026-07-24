import { describe, expect, it } from "vitest";

import { base64urlToBytes } from "./encoding.js";
import { generateSigningJwk, importSigningKey, SIGNING_ALG } from "./jws.js";
import { mintAccessToken, mintIdToken } from "./token.js";

/** Decode a compact JWS's header/payload without verifying. */
function decode(jws: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
} {
  const [h, p, s] = jws.split(".");
  return {
    header: JSON.parse(new TextDecoder().decode(base64urlToBytes(h!))),
    payload: JSON.parse(new TextDecoder().decode(base64urlToBytes(p!))),
    signingInput: `${h}.${p}`,
    signature: base64urlToBytes(s!),
  };
}

/** Verify an ES256 JWS the way a Solid pod does: import the public JWK, verify. */
async function verifyWithPublicJwk(
  jws: string,
  publicJwk: JsonWebKey,
): Promise<boolean> {
  const { signingInput, signature } = decode(jws);
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature,
    new TextEncoder().encode(signingInput),
  );
}

describe("importSigningKey", () => {
  it("imports a P-256 JWK and derives a public sig JWK with a kid", async () => {
    const jwk = await generateSigningJwk();
    const key = await importSigningKey(jwk);
    expect(key.publicJwk).toMatchObject({
      kty: "EC",
      crv: "P-256",
      use: "sig",
      alg: SIGNING_ALG,
    });
    expect(key.publicJwk.d).toBeUndefined(); // never leak the private scalar
    expect(typeof key.kid).toBe("string");
    expect(key.kid.length).toBeGreaterThan(0);
    expect((key.publicJwk as { kid?: string }).kid).toBe(key.kid);
  });

  it("derives a stable RFC 7638 thumbprint kid when the JWK carries none", async () => {
    // A freshly generated JWK carries no `kid`, so both imports derive it.
    const jwk = await generateSigningJwk();
    const a = await importSigningKey(jwk);
    const b = await importSigningKey(jwk);
    expect(a.kid).toBe(b.kid);
  });

  it("honors an explicit kid on the JWK", async () => {
    const jwk = { ...(await generateSigningJwk()), kid: "key-2026" };
    const key = await importSigningKey(jwk);
    expect(key.kid).toBe("key-2026");
  });

  it("rejects a non-EC or private-less JWK", async () => {
    await expect(importSigningKey({ kty: "RSA" })).rejects.toThrow();
    const pub = await generateSigningJwk();
    delete pub.d;
    await expect(importSigningKey(pub)).rejects.toThrow(/private/);
  });
});

describe("mintAccessToken", () => {
  const base = {
    issuer: "https://op.example",
    webid: "https://alice.example/profile#me",
    clientId: "https://app.example/id",
    scope: "openid webid",
    jkt: "kt-thumbprint",
    audience: ["solid", "https://alice.example"],
    lifetimeSeconds: 3600,
    now: 1_800_000_000,
  };

  it("mints an at+jwt whose signature verifies against the public JWK", async () => {
    const key = await importSigningKey(await generateSigningJwk());
    const { token } = await mintAccessToken(key, base);
    expect(await verifyWithPublicJwk(token, key.publicJwk)).toBe(true);
  });

  it("carries exactly the claims a Solid RS validates", async () => {
    const key = await importSigningKey(await generateSigningJwk());
    const { token, jti, expiresAt } = await mintAccessToken(key, base);
    const { header, payload } = decode(token);
    expect(header).toMatchObject({ alg: "ES256", typ: "at+jwt", kid: key.kid });
    expect(payload).toMatchObject({
      iss: "https://op.example",
      webid: "https://alice.example/profile#me",
      sub: "https://alice.example/profile#me",
      aud: ["solid", "https://alice.example"],
      client_id: "https://app.example/id",
      scope: "openid webid",
      cnf: { jkt: "kt-thumbprint" },
      iat: 1_800_000_000,
      exp: 1_800_003_600,
      jti,
    });
    expect(expiresAt).toBe(1_800_003_600);
  });

  it("a tampered payload no longer verifies", async () => {
    const key = await importSigningKey(await generateSigningJwk());
    const { token } = await mintAccessToken(key, base);
    const [h, , s] = token.split(".");
    const forged = `${h}.${btoa('{"iss":"evil"}')
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}.${s}`;
    expect(await verifyWithPublicJwk(forged, key.publicJwk)).toBe(false);
  });
});

describe("mintIdToken", () => {
  it("mints a JWT ID token with webid subject, client audience, and echoed nonce", async () => {
    const key = await importSigningKey(await generateSigningJwk());
    const token = await mintIdToken(key, {
      issuer: "https://op.example",
      webid: "https://alice.example/profile#me",
      clientId: "https://app.example/id",
      lifetimeSeconds: 600,
      now: 1_800_000_000,
      nonce: "n-123",
    });
    expect(await verifyWithPublicJwk(token, key.publicJwk)).toBe(true);
    const { header, payload } = decode(token);
    expect(header).toMatchObject({ alg: "ES256", typ: "JWT" });
    expect(payload).toMatchObject({
      iss: "https://op.example",
      sub: "https://alice.example/profile#me",
      webid: "https://alice.example/profile#me",
      aud: "https://app.example/id",
      azp: "https://app.example/id",
      nonce: "n-123",
    });
  });

  it("omits nonce when the request carried none", async () => {
    const key = await importSigningKey(await generateSigningJwk());
    const token = await mintIdToken(key, {
      issuer: "https://op.example",
      webid: "https://alice.example/profile#me",
      clientId: "https://app.example/id",
      lifetimeSeconds: 600,
      now: 1_800_000_000,
    });
    const { payload } = decode(token);
    expect(payload).not.toHaveProperty("nonce");
  });
});
