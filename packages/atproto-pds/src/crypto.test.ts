import { describe, expect, it } from "vitest";

import {
  createRepoKeypair,
  decodeMultikey,
  didKeyFromPublicKey,
  exportPublicKeyRaw,
  generateSigningKey,
  loadSigner,
  publicKeyMultibase,
  signData,
  verifyData,
} from "./crypto.js";

const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER >> 1n;

const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_ORDER = SECP256K1_ORDER >> 1n;

function lowHalf(sig: Uint8Array): bigint {
  let s = 0n;
  for (let j = 32; j < 64; j++) s = (s << 8n) | BigInt(sig[j] as number);
  return s;
}

describe("repository signing key (P-256)", () => {
  it("signs and verifies", async () => {
    const pair = await generateSigningKey();
    const raw = await exportPublicKeyRaw(pair.publicKey);
    const data = new TextEncoder().encode("commit bytes");
    const sig = await signData(pair.privateKey, data);
    expect(sig.length).toBe(64);
    expect(await verifyData(raw, data, sig)).toBe(true);
  });

  it("rejects a tampered message", async () => {
    const pair = await generateSigningKey();
    const raw = await exportPublicKeyRaw(pair.publicKey);
    const sig = await signData(pair.privateKey, new TextEncoder().encode("a"));
    expect(await verifyData(raw, new TextEncoder().encode("b"), sig)).toBe(
      false,
    );
  });

  it("emits low-S normalised signatures", async () => {
    const pair = await generateSigningKey();
    // Sign many messages; every S must be in the lower half of the group.
    for (let i = 0; i < 16; i++) {
      const sig = await signData(
        pair.privateKey,
        new TextEncoder().encode(`m${i}`),
      );
      let s = 0n;
      for (let j = 32; j < 64; j++) s = (s << 8n) | BigInt(sig[j] as number);
      expect(s <= P256_HALF_ORDER).toBe(true);
    }
  });

  it("formats a did:key with the p256 multibase prefix", async () => {
    const pair = await generateSigningKey();
    const raw = await exportPublicKeyRaw(pair.publicKey);
    const did = didKeyFromPublicKey(raw);
    expect(did.startsWith("did:key:zDn")).toBe(true);
    expect(publicKeyMultibase(raw).startsWith("zDn")).toBe(true);
  });
});

describe("repository signing key (secp256k1 / k-256)", () => {
  it("generates a curve-tagged keypair that round-trips a signer", async () => {
    const kp = await createRepoKeypair("secp256k1");
    expect(kp.curve).toBe("secp256k1");
    expect(kp.publicKeyRaw.length).toBe(65);
    expect(kp.publicKeyRaw[0]).toBe(0x04);
    expect(kp.privateKeyExport).toMatch(/^[0-9a-f]{64}$/);

    const sign = await loadSigner("secp256k1", kp.privateKeyExport);
    const data = new TextEncoder().encode("commit bytes");
    const sig = await sign(data);
    expect(sig.length).toBe(64);
    expect(await verifyData(kp.publicKeyRaw, data, sig, "secp256k1")).toBe(
      true,
    );
  });

  it("rejects a tampered message", async () => {
    const kp = await createRepoKeypair("secp256k1");
    const sign = await loadSigner("secp256k1", kp.privateKeyExport);
    const sig = await sign(new TextEncoder().encode("a"));
    expect(
      await verifyData(
        kp.publicKeyRaw,
        new TextEncoder().encode("b"),
        sig,
        "secp256k1",
      ),
    ).toBe(false);
  });

  it("emits low-S normalised signatures", async () => {
    const kp = await createRepoKeypair("secp256k1");
    const sign = await loadSigner("secp256k1", kp.privateKeyExport);
    for (let i = 0; i < 16; i++) {
      const sig = await sign(new TextEncoder().encode(`m${i}`));
      expect(lowHalf(sig) <= SECP256K1_HALF_ORDER).toBe(true);
    }
  });

  it("signs deterministically (RFC 6979)", async () => {
    const kp = await createRepoKeypair("secp256k1");
    const sign = await loadSigner("secp256k1", kp.privateKeyExport);
    const data = new TextEncoder().encode("same message");
    expect(await sign(data)).toEqual(await sign(data));
  });

  it("formats a did:key with the secp256k1 multibase prefix", async () => {
    const kp = await createRepoKeypair("secp256k1");
    expect(
      didKeyFromPublicKey(kp.publicKeyRaw, "secp256k1").startsWith(
        "did:key:zQ3sh",
      ),
    ).toBe(true);
    expect(
      publicKeyMultibase(kp.publicKeyRaw, "secp256k1").startsWith("zQ3sh"),
    ).toBe(true);
  });

  it("does not verify a P-256 signature under the k-256 curve", async () => {
    const pair = await generateSigningKey();
    const raw = await exportPublicKeyRaw(pair.publicKey);
    const data = new TextEncoder().encode("p256 message");
    const sig = await signData(pair.privateKey, data);
    // A P-256 signature must not validate against the secp256k1 verifier — the
    // curve is part of the identity, never inferred. (noble rejects the foreign
    // key/point, by return value or by throwing.)
    const verified = await verifyData(raw, data, sig, "secp256k1").catch(
      () => false,
    );
    expect(verified).toBe(false);
  });
});

describe("decodeMultikey", () => {
  it("round-trips publicKeyMultibase for both curves", async () => {
    for (const curve of ["p256", "secp256k1"] as const) {
      const kp = await createRepoKeypair(curve);
      const decoded = decodeMultikey(
        publicKeyMultibase(kp.publicKeyRaw, curve),
      );
      expect(decoded.curve).toBe(curve);
      expect(decoded.publicKeyRaw).toEqual(kp.publicKeyRaw);
    }
  });

  it("rejects a non-multibase or unknown-codec key", () => {
    expect(() => decodeMultikey("Qnotz")).toThrow(/multibase/);
  });
});

describe("createRepoKeypair default curve", () => {
  it("defaults to P-256", async () => {
    const kp = await createRepoKeypair();
    expect(kp.curve).toBe("p256");
    const sign = await loadSigner(kp.curve, kp.privateKeyExport);
    const data = new TextEncoder().encode("default curve");
    const sig = await sign(data);
    expect(lowHalf(sig) <= P256_HALF_ORDER).toBe(true);
    expect(await verifyData(kp.publicKeyRaw, data, sig)).toBe(true);
  });
});
