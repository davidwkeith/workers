/**
 * Multibase / Multikey encoding primitives used by Verifiable Credential proofs
 * and DID documents.
 *
 * Data Integrity proof values are **multibase base58-btc** strings (a leading
 * `z`), and a `Multikey` verification method publishes its public key as a
 * multibase base58-btc string over a **multicodec**-prefixed raw key. Status
 * lists are **multibase base64url** (a leading `u`). These helpers are pure
 * byte/string transforms with no Web Crypto or runtime dependency, so they
 * unit-test in isolation.
 *
 * @see https://www.w3.org/TR/controller-document/#multikey
 * @see https://github.com/multiformats/multibase
 */

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// Reverse lookup: code point → value, built once.
const BASE58_LOOKUP: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    map[BASE58_ALPHABET[i]!] = i;
  }
  return map;
})();

/** Multibase prefix characters this module understands. */
export const MULTIBASE_BASE58BTC = "z";
export const MULTIBASE_BASE64URL = "u";

/**
 * Multicodec varint prefixes for the key types published as a `Multikey`.
 * Encoded as unsigned LEB128 varints (the on-disk multicodec form).
 */
export const MULTICODEC_ED25519_PUB = Uint8Array.of(0xed, 0x01);

/** Encode raw bytes as base58-btc (no multibase prefix). */
export function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  // Count and preserve leading zero bytes as leading '1's.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert the base-256 big-endian integer to base-58 via repeated division.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    out += BASE58_ALPHABET[digits[i]!];
  }
  return out;
}

/** Decode a base58-btc string (no multibase prefix) to raw bytes. */
export function base58btcDecode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);

  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros++;

  const bytes: number[] = [];
  for (let i = zeros; i < input.length; i++) {
    const value = BASE58_LOOKUP[input[i]!];
    if (value === undefined) {
      throw new Error(`@dwk/vc: invalid base58 character "${input[i]}"`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[zeros + bytes.length - 1 - i] = bytes[i]!;
  }
  return out;
}

/** Base64url-encode bytes without padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode a base64url string (padded or not) to bytes. */
export function base64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode bytes as a multibase base58-btc string (`z…`). */
export function encodeMultibaseBase58btc(bytes: Uint8Array): string {
  return MULTIBASE_BASE58BTC + base58btcEncode(bytes);
}

/** Encode bytes as a multibase base64url string (`u…`). */
export function encodeMultibaseBase64url(bytes: Uint8Array): string {
  return MULTIBASE_BASE64URL + base64urlEncode(bytes);
}

/**
 * Decode a multibase string, dispatching on its prefix. Supports base58-btc
 * (`z`) and base64url (`u`) — the two encodings the VC suite emits.
 */
export function decodeMultibase(input: string): Uint8Array {
  if (input.length === 0) {
    throw new Error("@dwk/vc: empty multibase value");
  }
  const prefix = input[0];
  const rest = input.slice(1);
  if (prefix === MULTIBASE_BASE58BTC) return base58btcDecode(rest);
  if (prefix === MULTIBASE_BASE64URL) return base64urlDecode(rest);
  throw new Error(`@dwk/vc: unsupported multibase prefix "${prefix ?? ""}"`);
}

/**
 * Encode a raw Ed25519 public key (32 bytes) as a `Multikey`
 * `publicKeyMultibase` value: multibase base58-btc over the
 * multicodec-prefixed key.
 */
export function encodeEd25519Multikey(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== 32) {
    throw new Error(
      `@dwk/vc: Ed25519 public key must be 32 bytes, got ${rawPublicKey.length}`,
    );
  }
  const prefixed = new Uint8Array(
    MULTICODEC_ED25519_PUB.length + rawPublicKey.length,
  );
  prefixed.set(MULTICODEC_ED25519_PUB, 0);
  prefixed.set(rawPublicKey, MULTICODEC_ED25519_PUB.length);
  return encodeMultibaseBase58btc(prefixed);
}

/** The raw key bytes and key type recovered from a `publicKeyMultibase`. */
export interface DecodedMultikey {
  readonly keyType: "Ed25519";
  readonly rawPublicKey: Uint8Array;
}

/**
 * Decode a `Multikey` `publicKeyMultibase` value into its raw key bytes,
 * validating the multicodec prefix. Only Ed25519 is supported as a Multikey;
 * other key types are published as `publicKeyJwk` instead.
 */
export function decodeMultikey(publicKeyMultibase: string): DecodedMultikey {
  const bytes = decodeMultibase(publicKeyMultibase);
  if (
    bytes.length === MULTICODEC_ED25519_PUB.length + 32 &&
    bytes[0] === MULTICODEC_ED25519_PUB[0] &&
    bytes[1] === MULTICODEC_ED25519_PUB[1]
  ) {
    return {
      keyType: "Ed25519",
      rawPublicKey: bytes.slice(MULTICODEC_ED25519_PUB.length),
    };
  }
  throw new Error("@dwk/vc: unsupported or malformed Multikey prefix");
}
