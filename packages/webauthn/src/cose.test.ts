import { describe, expect, it } from "vitest";

import {
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  CoseError,
  coseToKey,
  cryptoParamsForCoseAlg,
  derToRawEcdsaSignature,
} from "./cose.js";
import { base64urlToBytes, bytesToBase64url } from "./encoding.js";
import { rawToDerEcdsaSignature } from "./test-harness.js";

describe("@dwk/webauthn cose", () => {
  it("converts an EC2 COSE key to a JWK", () => {
    const x = new Uint8Array(32).fill(1);
    const y = new Uint8Array(32).fill(2);
    const map = new Map<number, unknown>([
      [1, 2],
      [3, COSE_ALG_ES256],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]);
    const { jwk, alg } = coseToKey(map);
    expect(alg).toBe(COSE_ALG_ES256);
    expect(jwk).toMatchObject({
      kty: "EC",
      crv: "P-256",
      x: bytesToBase64url(x),
      y: bytesToBase64url(y),
    });
  });

  it("converts an RSA COSE key to a JWK", () => {
    const n = new Uint8Array(256).fill(7);
    const e = new Uint8Array([1, 0, 1]);
    const map = new Map<number, unknown>([
      [1, 3],
      [3, COSE_ALG_RS256],
      [-1, n],
      [-2, e],
    ]);
    const { jwk, alg } = coseToKey(map);
    expect(alg).toBe(COSE_ALG_RS256);
    expect(jwk).toMatchObject({
      kty: "RSA",
      n: bytesToBase64url(n),
      e: bytesToBase64url(e),
    });
  });

  it("rejects unsupported key types and curves", () => {
    expect(() => coseToKey(new Map<number, unknown>([[1, 99]]))).toThrow(
      CoseError,
    );
    expect(() =>
      coseToKey(
        new Map<number, unknown>([
          [1, 2],
          [3, COSE_ALG_ES256],
          [-1, 99],
          [-2, new Uint8Array(32)],
          [-3, new Uint8Array(32)],
        ]),
      ),
    ).toThrow(CoseError);
  });

  it("maps COSE algorithms to crypto params, rejecting unknown", () => {
    expect(cryptoParamsForCoseAlg(COSE_ALG_ES256)?.ec).toBe(true);
    expect(cryptoParamsForCoseAlg(COSE_ALG_RS256)?.ec).toBe(false);
    expect(cryptoParamsForCoseAlg(-999)).toBeNull();
  });

  it("round-trips a P-256 signature through DER ⇄ raw", () => {
    const raw = new Uint8Array(64);
    raw.fill(0xab, 0, 32);
    raw.fill(0xcd, 32);
    // High bit set in both integers → DER must add sign bytes; converting back
    // must recover the original fixed-length raw form.
    const der = rawToDerEcdsaSignature(raw);
    const recovered = derToRawEcdsaSignature(der, 64);
    expect(bytesToBase64url(recovered)).toBe(bytesToBase64url(raw));
  });

  it("left-pads short integers when converting DER to raw", () => {
    // r and s that are shorter than 32 bytes must be left-padded.
    const raw = new Uint8Array(64);
    raw[31] = 0x01; // r = 1
    raw[63] = 0x02; // s = 2
    const der = rawToDerEcdsaSignature(raw);
    expect(bytesToBase64url(derToRawEcdsaSignature(der, 64))).toBe(
      bytesToBase64url(raw),
    );
  });

  it("rejects a malformed DER signature", () => {
    expect(() =>
      derToRawEcdsaSignature(new Uint8Array([0x02, 0x01, 0x01]), 64),
    ).toThrow(CoseError);
    expect(() => derToRawEcdsaSignature(base64urlToBytes(""), 64)).toThrow(
      CoseError,
    );
  });
});
