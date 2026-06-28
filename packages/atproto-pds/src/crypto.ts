/**
 * Repository signing keys for the two curves AT Protocol's cryptography spec
 * admits: **P-256** (`p256` / NIST secp256r1) and **secp256k1** (`k-256`).
 *
 * P-256 is implemented entirely on WebCrypto (no `node:crypto`, no external
 * dependency) and stays the **default**, because it is the dependency-free,
 * self-hosted-friendly choice. secp256k1 is the *network-preferred* curve — the
 * one existing Bluesky accounts already sign with — but WebCrypto cannot do it,
 * so it is implemented over the audited {@link https://github.com/paulmillr/noble-curves `@noble/curves`}
 * `secp256k1`. Supporting it is what lets this PDS host a real, migrated account
 * (see `spec/packages/atproto-pds.md`).
 *
 * Both curves emit signatures in the compact 64-byte `r‖s` form and **low-S
 * normalised**, as the protocol requires for deterministic verification, and
 * sign over the **SHA-256 digest** of the input (P-256 via WebCrypto's internal
 * hash, secp256k1 by pre-hashing). The curve travels with the public key as a
 * multicodec-tagged `did:key`/Multikey, never inferred from raw key bytes.
 */

import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

import {
  base58btcDecode,
  base58btcEncode,
  concatBytes,
  fromHex,
  toHex,
} from "./bytes.js";

/** The signing curves AT Protocol admits; P-256 is this package's default. */
export type SigningCurve = "p256" | "secp256k1";

/** P-256 group order, for low-S normalisation. */
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER >> 1n;

/** Multicodec varint prefix for a `p256-pub` key (0x1200). */
const P256_MULTICODEC = Uint8Array.from([0x80, 0x24]);
/** Multicodec varint prefix for a `secp256k1-pub` key (0xe7). */
const SECP256K1_MULTICODEC = Uint8Array.from([0xe7, 0x01]);

const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;

/** SHA-256 the input, the digest both curves sign/verify over. */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", data as BufferSource),
  );
}

// --- P-256 (WebCrypto) ------------------------------------------------------

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

/** Compress an uncompressed SEC1 public key to its 33-byte form. */
export function compressPublicKey(raw: Uint8Array): Uint8Array {
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("crypto: expected a 65-byte uncompressed key");
  }
  const x = raw.slice(1, 33);
  const yIsOdd = (raw[64] as number) & 1;
  return concatBytes([Uint8Array.from([yIsOdd ? 0x03 : 0x02]), x]);
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

/** Sign `data` with a P-256 key, returning a low-S 64-byte signature. */
export async function signData(
  privateKey: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await crypto.subtle.sign(SIGN_PARAMS, privateKey, data as BufferSource),
  );
  return normalizeLowS(raw);
}

// --- curve-agnostic repository key abstraction ------------------------------

/**
 * A repository signing keypair, curve-tagged and persistable. The DO stores
 * {@link privateKeyExport} (a curve-specific opaque string — a JWK for P-256, a
 * hex secret for secp256k1) and {@link publicKeyRaw}, and reloads a signer with
 * {@link loadSigner}.
 */
export interface RepoKeypair {
  readonly curve: SigningCurve;
  readonly privateKeyExport: string;
  readonly publicKeyRaw: Uint8Array;
}

/** A signer: maps the canonical signed bytes to a low-S 64-byte `r‖s`. */
export type Signer = (data: Uint8Array) => Promise<Uint8Array>;

/** Generate a fresh repository keypair on the given curve (defaults to P-256). */
export async function createRepoKeypair(
  curve: SigningCurve = "p256",
): Promise<RepoKeypair> {
  if (curve === "secp256k1") {
    const secret = secp256k1.utils.randomSecretKey();
    return {
      curve,
      privateKeyExport: toHex(secret),
      publicKeyRaw: secp256k1.getPublicKey(secret, false),
    };
  }
  const pair = await generateSigningKey();
  return {
    curve: "p256",
    privateKeyExport: JSON.stringify(await exportPrivateJwk(pair.privateKey)),
    publicKeyRaw: await exportPublicKeyRaw(pair.publicKey),
  };
}

/** Reconstruct a {@link Signer} from a persisted {@link RepoKeypair} export. */
export async function loadSigner(
  curve: SigningCurve,
  privateKeyExport: string,
): Promise<Signer> {
  if (curve === "secp256k1") {
    const secret = fromHex(privateKeyExport);
    return async (data) =>
      secp256k1.sign(await sha256(data), secret, { lowS: true });
  }
  const key = await importPrivateJwk(
    JSON.parse(privateKeyExport) as JsonWebKey,
  );
  return (data) => signData(key, data);
}

// --- did:key / Multikey -----------------------------------------------------

function multicodecFor(curve: SigningCurve): Uint8Array {
  return curve === "secp256k1" ? SECP256K1_MULTICODEC : P256_MULTICODEC;
}

/**
 * The multibase (`z…`) string for a public key, as used in `did:key`/Multikey.
 * The multicodec prefix records the curve, so verification never has to guess it.
 */
export function publicKeyMultibase(
  raw: Uint8Array,
  curve: SigningCurve = "p256",
): string {
  const compressed = compressPublicKey(raw);
  return "z" + base58btcEncode(concatBytes([multicodecFor(curve), compressed]));
}

/** The `did:key` identifier for a public key. */
export function didKeyFromPublicKey(
  raw: Uint8Array,
  curve: SigningCurve = "p256",
): string {
  return "did:key:" + publicKeyMultibase(raw, curve);
}

/** A public key recovered from a Multikey: its raw bytes and curve. */
export interface DecodedMultikey {
  /** 65-byte uncompressed public key (`0x04 ‖ x ‖ y`). */
  readonly publicKeyRaw: Uint8Array;
  readonly curve: SigningCurve;
}

/**
 * Decode a `z…` Multikey (the inverse of {@link publicKeyMultibase}) back to a
 * raw public key and its curve, reading the multicodec prefix and decompressing
 * the SEC1 point. Used to recover a foreign account's signing key from its DID
 * document — e.g. to verify a migrating repository's commits.
 */
export function decodeMultikey(multibase: string): DecodedMultikey {
  if (!multibase.startsWith("z")) {
    throw new Error(
      "crypto: Multikey must be a 'z' base58btc multibase string",
    );
  }
  const bytes = base58btcDecode(multibase.slice(1));
  if (bytes.length < 3) throw new Error("crypto: Multikey is too short");
  let curve: SigningCurve;
  if (bytes[0] === 0x80 && bytes[1] === 0x24) curve = "p256";
  else if (bytes[0] === 0xe7 && bytes[1] === 0x01) curve = "secp256k1";
  else throw new Error("crypto: unsupported Multikey codec");
  const compressed = bytes.slice(2);
  const point = (curve === "secp256k1" ? secp256k1 : p256).Point.fromBytes(
    compressed,
  );
  return { publicKeyRaw: point.toBytes(false), curve };
}

// --- verification -----------------------------------------------------------

/**
 * Verify a 64-byte `r‖s` signature against a raw uncompressed public key on the
 * named curve (defaults to P-256). Both paths require low-S, matching what the
 * signers emit.
 */
export async function verifyData(
  publicKeyRaw: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
  curve: SigningCurve = "p256",
): Promise<boolean> {
  if (curve === "secp256k1") {
    return secp256k1.verify(signature, await sha256(data), publicKeyRaw, {
      lowS: true,
    });
  }
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
