/**
 * Repository signing keys, implemented entirely on WebCrypto so the package
 * needs no `node:crypto` and no external elliptic-curve dependency.
 *
 * AT Protocol's cryptography spec admits two curves; this uses **P-256**
 * (`p256` / NIST secp256r1), which WebCrypto supports natively as ECDSA. K-256
 * (secp256k1) is the network-preferred curve but is unavailable in WebCrypto, so
 * a self-hosted, dependency-free PDS standardises on P-256 — a spec-valid choice
 * exposed through a `did:key` (multicodec 0x1200) the same way the rest of the
 * cohort handles `did:web` key material.
 *
 * Signatures are emitted in the compact 64-byte `r‖s` form and **low-S
 * normalised**, as the protocol requires for deterministic verification.
 */

import { base58btcEncode, concatBytes } from "./bytes";

/** P-256 group order, for low-S normalisation. */
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER >> 1n;

/** Multicodec varint prefix for a `p256-pub` key (0x1200). */
const P256_MULTICODEC = Uint8Array.from([0x80, 0x24]);

const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;

/** Generate an extractable P-256 signing keypair for a repository. */
export async function generateSigningKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(ECDSA_PARAMS, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

/** Export a private key as a JWK so the owning Durable Object can persist it. */
export async function exportPrivateJwk(key: CryptoKey): Promise<JsonWebKey> {
  return (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
}

/** Re-import a persisted private-key JWK. */
export async function importPrivateJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ECDSA_PARAMS, true, ["sign"]);
}

/** Export the raw uncompressed public key (65 bytes, `0x04 ‖ x ‖ y`). */
export async function exportPublicKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(
    (await crypto.subtle.exportKey("raw", key)) as ArrayBuffer,
  );
}

/** Compress an uncompressed P-256 public key to its 33-byte SEC1 form. */
export function compressPublicKey(raw: Uint8Array): Uint8Array {
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("crypto: expected a 65-byte uncompressed P-256 key");
  }
  const x = raw.slice(1, 33);
  const yIsOdd = (raw[64] as number) & 1;
  return concatBytes([Uint8Array.from([yIsOdd ? 0x03 : 0x02]), x]);
}

/** The multibase (`z…`) string for a public key, as used in `did:key`/Multikey. */
export function publicKeyMultibase(raw: Uint8Array): string {
  const compressed = compressPublicKey(raw);
  return "z" + base58btcEncode(concatBytes([P256_MULTICODEC, compressed]));
}

/** The `did:key` identifier for a public key. */
export function didKeyFromPublicKey(raw: Uint8Array): string {
  return "did:key:" + publicKeyMultibase(raw);
}

/** Re-serialise a raw `r‖s` signature with its S value low-S normalised. */
function normalizeLowS(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) {
    throw new Error("crypto: expected a 64-byte r‖s signature");
  }
  let s = 0n;
  for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(signature[i] as number);
  if (s <= P256_HALF_ORDER) return signature;
  // S is in the upper half of the group; replace it with n - S.
  let low = P256_ORDER - s;
  const out = signature.slice();
  for (let i = 31; i >= 0; i--) {
    out[32 + i] = Number(low & 0xffn);
    low >>= 8n;
  }
  return out;
}

/** Sign `data` with the repository key, returning a low-S 64-byte signature. */
export async function signData(
  privateKey: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await crypto.subtle.sign(SIGN_PARAMS, privateKey, data as BufferSource),
  );
  return normalizeLowS(raw);
}

/** Verify a 64-byte `r‖s` signature against a raw uncompressed public key. */
export async function verifyData(
  publicKeyRaw: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    publicKeyRaw as BufferSource,
    ECDSA_PARAMS,
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    SIGN_PARAMS,
    key,
    signature as BufferSource,
    data as BufferSource,
  );
}
