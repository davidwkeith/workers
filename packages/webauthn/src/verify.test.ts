import { beforeAll, describe, expect, it } from "vitest";

import { COSE_ALG_ES256 } from "./cose";
import { utf8ToBytes } from "./encoding";
import {
  parseAuthenticatorData,
  parseClientData,
  verifyAuthentication,
  verifyRegistration,
  type VerifiedCredential,
} from "./verify";
import {
  buildAttestationObject,
  buildAuthData,
  buildClientDataJSON,
  createTestCredential,
  signAssertion,
  type TestCredential,
} from "./test-harness";

const RP_ID = "example.com";
const ORIGIN = "https://example.com";
const REG_CHALLENGE = "cmVnaXN0cmF0aW9uLWNoYWxsZW5nZQ";
const AUTH_CHALLENGE = "YXV0aGVudGljYXRpb24tY2hhbGxlbmdl";

let credential: TestCredential;
let registered: VerifiedCredential;

async function register(overrides?: {
  challenge?: string;
  origin?: string;
  rpId?: string;
  flags?: { up?: boolean; uv?: boolean };
  requireUserVerification?: boolean;
}) {
  const clientDataJSON = buildClientDataJSON({
    type: "webauthn.create",
    challenge: overrides?.challenge ?? REG_CHALLENGE,
    origin: overrides?.origin ?? ORIGIN,
  });
  const authData = await buildAuthData({
    rpId: overrides?.rpId ?? RP_ID,
    signCount: 0,
    credential,
    ...(overrides?.flags ? { flags: overrides.flags } : {}),
  });
  return verifyRegistration({
    attestationObject: buildAttestationObject(authData),
    clientDataJSON,
    expectedChallenge: REG_CHALLENGE,
    expectedOrigins: [ORIGIN],
    expectedRpId: RP_ID,
    requireUserVerification: overrides?.requireUserVerification ?? false,
  });
}

beforeAll(async () => {
  credential = await createTestCredential();
  const result = await register();
  if (!result.verified)
    throw new Error(`fixture registration failed: ${result.reason}`);
  registered = result.credential;
});

describe("@dwk/webauthn parse helpers", () => {
  it("parses clientDataJSON, rejecting malformed input", () => {
    const data = buildClientDataJSON({
      type: "webauthn.get",
      challenge: "abc",
      origin: ORIGIN,
    });
    expect(parseClientData(data)).toMatchObject({
      type: "webauthn.get",
      challenge: "abc",
      origin: ORIGIN,
    });
    expect(parseClientData(utf8ToBytes("not json"))).toBeNull();
    expect(
      parseClientData(utf8ToBytes(JSON.stringify({ type: "x" }))),
    ).toBeNull();
  });

  it("parses authenticator data flags and counter", async () => {
    const authData = await buildAuthData({
      rpId: RP_ID,
      signCount: 42,
      flags: { up: true, uv: true },
    });
    const parsed = parseAuthenticatorData(authData);
    expect(parsed?.signCount).toBe(42);
    expect(parsed?.flags.up).toBe(true);
    expect(parsed?.flags.uv).toBe(true);
    expect(parsed?.flags.at).toBe(false);
    expect(parseAuthenticatorData(new Uint8Array(10))).toBeNull();
  });
});

describe("@dwk/webauthn verifyRegistration", () => {
  it("verifies a well-formed `none` attestation", () => {
    expect(registered.id).toBe(credential.credentialIdB64);
    expect(registered.alg).toBe(COSE_ALG_ES256);
    expect(registered.counter).toBe(0);
    expect(registered.publicKeyJwk.kty).toBe("EC");
  });

  it("rejects a challenge mismatch", async () => {
    const result = await register({ challenge: "d3JvbmctY2hhbGxlbmdl" });
    expect(result).toMatchObject({
      verified: false,
      reason: "challenge_mismatch",
    });
  });

  it("rejects an origin mismatch", async () => {
    const result = await register({ origin: "https://evil.example" });
    expect(result).toMatchObject({
      verified: false,
      reason: "origin_mismatch",
    });
  });

  it("rejects an rpId mismatch", async () => {
    const result = await register({ rpId: "evil.example" });
    expect(result).toMatchObject({ verified: false, reason: "rp_id_mismatch" });
  });

  it("rejects when user is not present", async () => {
    const result = await register({ flags: { up: false } });
    expect(result).toMatchObject({
      verified: false,
      reason: "user_not_present",
    });
  });

  it("requires user verification when configured", async () => {
    const result = await register({
      flags: { up: true, uv: false },
      requireUserVerification: true,
    });
    expect(result).toMatchObject({
      verified: false,
      reason: "user_not_verified",
    });
  });

  it("rejects a malformed attestation object", async () => {
    const result = await verifyRegistration({
      attestationObject: new Uint8Array([0x00, 0x01]),
      clientDataJSON: buildClientDataJSON({
        type: "webauthn.create",
        challenge: REG_CHALLENGE,
        origin: ORIGIN,
      }),
      expectedChallenge: REG_CHALLENGE,
      expectedOrigins: [ORIGIN],
      expectedRpId: RP_ID,
      requireUserVerification: false,
    });
    expect(result).toMatchObject({
      verified: false,
      reason: "attestation_malformed",
    });
  });

  it("rejects the wrong clientData type", async () => {
    const result = await verifyRegistration({
      attestationObject: buildAttestationObject(
        await buildAuthData({ rpId: RP_ID, signCount: 0, credential }),
      ),
      clientDataJSON: buildClientDataJSON({
        type: "webauthn.get",
        challenge: REG_CHALLENGE,
        origin: ORIGIN,
      }),
      expectedChallenge: REG_CHALLENGE,
      expectedOrigins: [ORIGIN],
      expectedRpId: RP_ID,
      requireUserVerification: false,
    });
    expect(result).toMatchObject({
      verified: false,
      reason: "client_data_type",
    });
  });
});

describe("@dwk/webauthn verifyAuthentication", () => {
  async function authenticate(overrides?: {
    signCount?: number;
    storedCounter?: number;
    challenge?: string;
    tamper?: boolean;
  }) {
    const clientDataJSON = buildClientDataJSON({
      type: "webauthn.get",
      challenge: overrides?.challenge ?? AUTH_CHALLENGE,
      origin: ORIGIN,
    });
    const authData = await buildAuthData({
      rpId: RP_ID,
      signCount: overrides?.signCount ?? 1,
    });
    const signature = await signAssertion(credential, authData, clientDataJSON);
    if (overrides?.tamper) {
      const last = signature.length - 1;
      signature[last] = (signature[last] ?? 0) ^ 0xff;
    }
    return verifyAuthentication({
      authenticatorData: authData,
      clientDataJSON,
      signature,
      expectedChallenge: AUTH_CHALLENGE,
      expectedOrigins: [ORIGIN],
      expectedRpId: RP_ID,
      requireUserVerification: false,
      credentialPublicKeyJwk: registered.publicKeyJwk,
      credentialAlg: registered.alg,
      storedCounter: overrides?.storedCounter ?? 0,
    });
  }

  it("verifies a valid assertion and returns the new counter", async () => {
    const result = await authenticate({ signCount: 7 });
    expect(result).toMatchObject({ verified: true, newCounter: 7 });
  });

  it("rejects a tampered signature", async () => {
    const result = await authenticate({ tamper: true });
    expect(result).toMatchObject({
      verified: false,
      reason: "signature_invalid",
    });
  });

  it("rejects a non-increasing counter (clone detection)", async () => {
    const result = await authenticate({ signCount: 5, storedCounter: 5 });
    expect(result).toMatchObject({
      verified: false,
      reason: "counter_regression",
    });
  });

  it("allows a zero/zero counter pair (counters unsupported)", async () => {
    const result = await authenticate({ signCount: 0, storedCounter: 0 });
    expect(result).toMatchObject({ verified: true, newCounter: 0 });
  });

  it("rejects a challenge mismatch", async () => {
    const result = await authenticate({ challenge: "d3Jvbmc" });
    expect(result).toMatchObject({
      verified: false,
      reason: "challenge_mismatch",
    });
  });
});
