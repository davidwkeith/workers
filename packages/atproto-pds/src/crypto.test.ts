import { describe, expect, it } from "vitest";

import {
  didKeyFromPublicKey,
  exportPublicKeyRaw,
  generateSigningKey,
  publicKeyMultibase,
  signData,
  verifyData,
} from "./crypto";

const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER >> 1n;

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
