/**
 * Algorithm allow-list and the Web Crypto primitives that back it.
 *
 * Mirrors the `@dwk/dpop` hardening posture: asymmetric algorithms only, an
 * explicit allow-list (no `none`, no HMAC), and the resolved key is validated
 * against the claimed algorithm — RSA moduli below 2048 bits and curve
 * mismatches are rejected before any signature is checked.
 */

import type { SignatureAlgorithm } from "./types";

// Structural shapes for Web Crypto algorithm parameters. We avoid the DOM lib
// names (RsaPssParams, EcdsaParams, …) because @cloudflare/workers-types does
// not declare them; these objects are accepted structurally by crypto.subtle.
interface ImportAlg {
  name: string;
  namedCurve?: string;
  hash?: string;
}
interface SignVerifyAlg {
  name: string;
  hash?: string;
  saltLength?: number;
}

interface AlgSpec {
  /** Web Crypto key algorithm name the resolved key must report. */
  keyName: string;
  /** For EC algorithms, the curve the resolved key must use. */
  expectedCurve?: string;
  /** Whether the key type is RSA (so the 2048-bit floor applies). */
  rsa: boolean;
  importParams: ImportAlg;
  signParams: SignVerifyAlg;
}

const ALGS: Record<SignatureAlgorithm, AlgSpec> = {
  "rsa-pss-sha512": {
    keyName: "RSA-PSS",
    rsa: true,
    importParams: { name: "RSA-PSS", hash: "SHA-512" },
    signParams: { name: "RSA-PSS", saltLength: 64 },
  },
  "rsa-v1_5-sha256": {
    keyName: "RSASSA-PKCS1-v1_5",
    rsa: true,
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    signParams: { name: "RSASSA-PKCS1-v1_5" },
  },
  "ecdsa-p256-sha256": {
    keyName: "ECDSA",
    expectedCurve: "P-256",
    rsa: false,
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    signParams: { name: "ECDSA", hash: "SHA-256" },
  },
  "ecdsa-p384-sha384": {
    keyName: "ECDSA",
    expectedCurve: "P-384",
    rsa: false,
    importParams: { name: "ECDSA", namedCurve: "P-384" },
    signParams: { name: "ECDSA", hash: "SHA-384" },
  },
  ed25519: {
    keyName: "Ed25519",
    rsa: false,
    importParams: { name: "Ed25519" },
    signParams: { name: "Ed25519" },
  },
};

/** Minimum accepted RSA modulus size, in bits. */
const MIN_RSA_KEY_BITS = 2048;

/** Whether `alg` is in the allow-list. */
export function isSupportedAlgorithm(alg: string): alg is SignatureAlgorithm {
  return Object.prototype.hasOwnProperty.call(ALGS, alg);
}

/** The reasons {@link validateKey} can reject a key, or `null` when it is sound. */
export type KeyRejection = "key_alg_mismatch" | "key_too_small";

// The subset of CryptoKey.algorithm members we inspect. Declared structurally
// for the same reason as the param shapes above.
interface KeyAlgorithm {
  name: string;
  modulusLength?: number;
  namedCurve?: string;
}

/**
 * Validate that a resolved {@link CryptoKey} matches the claimed algorithm:
 * the key's algorithm name and EC curve must line up, and RSA moduli must meet
 * the {@link MIN_RSA_KEY_BITS} floor. Returns `null` when the key is acceptable.
 */
export function validateKey(
  key: CryptoKey,
  alg: SignatureAlgorithm,
): KeyRejection | null {
  const spec = ALGS[alg];
  const keyAlg = key.algorithm as KeyAlgorithm;
  if (keyAlg.name !== spec.keyName) {
    return "key_alg_mismatch";
  }
  if (spec.expectedCurve && keyAlg.namedCurve !== spec.expectedCurve) {
    return "key_alg_mismatch";
  }
  if (
    spec.rsa &&
    typeof keyAlg.modulusLength === "number" &&
    keyAlg.modulusLength < MIN_RSA_KEY_BITS
  ) {
    return "key_too_small";
  }
  return null;
}

/** Sign `data` with `key` under `alg`. */
export function signBytes(
  key: CryptoKey,
  alg: SignatureAlgorithm,
  data: Uint8Array,
): Promise<ArrayBuffer> {
  return crypto.subtle.sign(ALGS[alg].signParams, key, data);
}

/** Verify `signature` over `data` with `key` under `alg`. Never throws. */
export async function verifyBytes(
  key: CryptoKey,
  alg: SignatureAlgorithm,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      ALGS[alg].signParams,
      key,
      signature,
      data,
    );
  } catch {
    return false;
  }
}
