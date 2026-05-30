import { describe, it, expect, beforeAll } from "vitest";

import { verifyDpopProof, DEFAULT_MAX_AGE_SECONDS } from "./index";

// ---------------------------------------------------------------------------
// Test helpers: craft real, signed DPoP proofs with Web Crypto so the suite
// exercises the actual signature/thumbprint paths (no mocking of crypto).
// ---------------------------------------------------------------------------

const HTM = "POST";
const HTU = "https://pod.example/resource";
const NOW = 1_700_000_000;

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

interface SignerSpec {
  generate: EcKeyGenParams | RsaHashedKeyGenParams;
  sign: EcdsaParams | AlgorithmIdentifier | RsaPssParams;
  alg: string;
}

const SIGNERS: Record<string, SignerSpec> = {
  ES256: {
    generate: { name: "ECDSA", namedCurve: "P-256" },
    sign: { name: "ECDSA", hash: "SHA-256" },
    alg: "ES256",
  },
  RS256: {
    generate: {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    sign: { name: "RSASSA-PKCS1-v1_5" },
    alg: "RS256",
  },
};

interface KeyMaterial {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  spec: SignerSpec;
}

async function makeKey(name: string): Promise<KeyMaterial> {
  const spec = SIGNERS[name]!;
  const pair = (await crypto.subtle.generateKey(spec.generate, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk, spec };
}

interface ProofOptions {
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  /** Tamper with the signature after signing. */
  tamper?: boolean;
}

async function makeProof(
  key: KeyMaterial,
  opts: ProofOptions = {},
): Promise<string> {
  const header = {
    typ: "dpop+jwt",
    alg: key.spec.alg,
    jwk: key.publicJwk,
    ...opts.header,
  };
  const payload = {
    htm: HTM,
    htu: HTU,
    iat: NOW,
    jti: "unique-id-123",
    ...opts.payload,
  };
  const headerSeg = textToBase64url(JSON.stringify(header));
  const payloadSeg = textToBase64url(JSON.stringify(payload));
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      key.spec.sign,
      key.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  if (opts.tamper) signature[0] = (signature[0] ?? 0) ^ 0xff;
  return `${signingInput}.${bytesToBase64url(signature)}`;
}

let es256: KeyMaterial;
let rs256: KeyMaterial;

beforeAll(async () => {
  es256 = await makeKey("ES256");
  rs256 = await makeKey("RS256");
});

const base = () => ({ htm: HTM, htu: HTU, now: NOW });

describe("verifyDpopProof — happy path", () => {
  it("verifies a valid ES256 proof and returns jti + jkt", async () => {
    const proof = await makeProof(es256);
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result.valid).toBe(true);
    expect(result.jti).toBe("unique-id-123");
    expect(result.jkt).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.reason).toBeUndefined();
  });

  it("verifies a valid RS256 proof (RSA thumbprint + signature path)", async () => {
    const proof = await makeProof(rs256);
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result.valid).toBe(true);
    expect(result.jkt).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("matches htm case-insensitively and normalizes htu", async () => {
    const proof = await makeProof(es256, {
      payload: { htu: "https://POD.example:443/resource?q=1#frag" },
    });
    const result = await verifyDpopProof({ ...base(), htm: "post", proof });
    expect(result.valid).toBe(true);
  });

  it("computes a stable RFC 7638 jkt for the same key", async () => {
    const a = await verifyDpopProof({
      ...base(),
      proof: await makeProof(es256),
    });
    const b = await verifyDpopProof({
      ...base(),
      proof: await makeProof(es256),
    });
    expect(a.jkt).toBe(b.jkt);
  });

  it("defaults `now` to the current time when omitted", async () => {
    const proof = await makeProof(es256, {
      payload: { iat: Math.floor(Date.now() / 1000) },
    });
    const result = await verifyDpopProof({ htm: HTM, htu: HTU, proof });
    expect(result.valid).toBe(true);
  });
});

describe("verifyDpopProof — malformed input", () => {
  it("rejects a proof without three segments", async () => {
    const result = await verifyDpopProof({ ...base(), proof: "a.b" });
    expect(result).toMatchObject({ valid: false, reason: "proof_malformed" });
  });

  it("rejects a segment with non-base64url characters", async () => {
    const result = await verifyDpopProof({ ...base(), proof: "!!!.@@@.###" });
    expect(result).toMatchObject({ valid: false, reason: "proof_malformed" });
  });

  it("rejects a header that is not JSON", async () => {
    const proof = `${textToBase64url("not json")}.${textToBase64url("{}")}.${textToBase64url("sig")}`;
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "header_invalid" });
  });
});

describe("verifyDpopProof — header checks", () => {
  it("rejects a wrong typ", async () => {
    const proof = await makeProof(es256, { header: { typ: "jwt" } });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "typ_invalid" });
  });

  it("rejects a disallowed alg (HS256 / symmetric)", async () => {
    const proof = await makeProof(es256, { header: { alg: "HS256" } });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "alg_unsupported" });
  });

  it("rejects alg 'none'", async () => {
    const proof = await makeProof(es256, { header: { alg: "none" } });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "alg_unsupported" });
  });

  it("rejects a missing jwk", async () => {
    const proof = await makeProof(es256, { header: { jwk: undefined } });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "jwk_missing" });
  });

  it("rejects a jwk that carries private key material", async () => {
    const proof = await makeProof(es256, {
      header: { jwk: { ...es256.publicJwk, d: "private-scalar" } },
    });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "jwk_private" });
  });

  it("rejects a jwk whose kty does not match the alg", async () => {
    const proof = await makeProof(es256, { header: { jwk: rs256.publicJwk } });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "jwk_invalid" });
  });
});

describe("verifyDpopProof — signature", () => {
  it("rejects a tampered signature", async () => {
    const proof = await makeProof(es256, { tamper: true });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "signature_invalid" });
  });

  it("rejects a proof signed by a different key than the embedded jwk", async () => {
    const other = await makeKey("ES256");
    // Sign with `other` but advertise es256's public jwk.
    const proof = await makeProof({ ...other, publicJwk: es256.publicJwk });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "signature_invalid" });
  });
});

describe("verifyDpopProof — claim checks", () => {
  it("rejects an htm mismatch", async () => {
    const proof = await makeProof(es256, { payload: { htm: "GET" } });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "htm_mismatch" });
  });

  it("rejects an htu mismatch", async () => {
    const proof = await makeProof(es256, {
      payload: { htu: "https://evil.example/resource" },
    });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "htu_mismatch" });
  });

  it("rejects an unparsable request htu", async () => {
    const proof = await makeProof(es256);
    const result = await verifyDpopProof({
      ...base(),
      htu: "not a uri",
      proof,
    });
    expect(result).toMatchObject({ valid: false, reason: "htu_invalid" });
  });

  it("rejects an expired proof (iat too old)", async () => {
    const proof = await makeProof(es256, { payload: { iat: NOW - 1000 } });
    const result = await verifyDpopProof({
      ...base(),
      proof,
      maxAgeSeconds: 300,
    });
    expect(result).toMatchObject({ valid: false, reason: "proof_expired" });
  });

  it("rejects an early proof (iat in the future beyond skew)", async () => {
    const proof = await makeProof(es256, { payload: { iat: NOW + 1000 } });
    const result = await verifyDpopProof({
      ...base(),
      proof,
      maxAgeSeconds: 300,
    });
    expect(result).toMatchObject({ valid: false, reason: "proof_future" });
  });

  it("rejects a missing iat", async () => {
    const proof = await makeProof(es256, { payload: { iat: undefined } });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "iat_invalid" });
  });

  it("rejects a missing jti", async () => {
    const proof = await makeProof(es256, { payload: { jti: undefined } });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "jti_missing" });
  });

  it("rejects an empty jti", async () => {
    const proof = await makeProof(es256, { payload: { jti: "" } });
    const result = await verifyDpopProof({ ...base(), proof });
    expect(result).toMatchObject({ valid: false, reason: "jti_missing" });
  });

  it("applies the default clock-skew window when maxAgeSeconds is omitted", async () => {
    const justInside = await makeProof(es256, {
      payload: { iat: NOW - DEFAULT_MAX_AGE_SECONDS },
    });
    const justOutside = await makeProof(es256, {
      payload: { iat: NOW - DEFAULT_MAX_AGE_SECONDS - 1 },
    });
    expect(
      (await verifyDpopProof({ ...base(), proof: justInside })).valid,
    ).toBe(true);
    expect(
      await verifyDpopProof({ ...base(), proof: justOutside }),
    ).toMatchObject({
      valid: false,
      reason: "proof_expired",
    });
  });
});

describe("verifyDpopProof — Resource Server bindings", () => {
  const accessToken = "an-opaque-access-token";

  async function ath(token: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token),
    );
    return bytesToBase64url(new Uint8Array(digest));
  }

  it("accepts a proof with a matching ath", async () => {
    const proof = await makeProof(es256, {
      payload: { ath: await ath(accessToken) },
    });
    const result = await verifyDpopProof({ ...base(), proof, accessToken });
    expect(result.valid).toBe(true);
  });

  it("rejects a proof missing ath when an access token is presented", async () => {
    const proof = await makeProof(es256);
    const result = await verifyDpopProof({ ...base(), proof, accessToken });
    expect(result).toMatchObject({ valid: false, reason: "ath_mismatch" });
  });

  it("rejects a proof whose ath is for a different token", async () => {
    const proof = await makeProof(es256, {
      payload: { ath: await ath("some-other-token") },
    });
    const result = await verifyDpopProof({ ...base(), proof, accessToken });
    expect(result).toMatchObject({ valid: false, reason: "ath_mismatch" });
  });

  it("accepts a proof whose jkt matches the expected cnf.jkt", async () => {
    const computed = (
      await verifyDpopProof({ ...base(), proof: await makeProof(es256) })
    ).jkt!;
    const result = await verifyDpopProof({
      ...base(),
      proof: await makeProof(es256),
      expectedJkt: computed,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a cnf.jkt mismatch", async () => {
    const proof = await makeProof(es256);
    const result = await verifyDpopProof({
      ...base(),
      proof,
      expectedJkt: "not-the-right-thumbprint",
    });
    expect(result).toMatchObject({ valid: false, reason: "jkt_mismatch" });
  });
});
