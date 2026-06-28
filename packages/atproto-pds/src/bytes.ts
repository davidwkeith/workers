/**
 * Byte-buffer helpers: concatenation, equality, and the multibase alphabets
 * (base32-lower for CIDs, base58btc for `did:key`) AT Protocol relies on.
 *
 * Pure and dependency-free — everything here is synchronous byte twiddling so it
 * unit-tests without a Workers runtime.
 */

/** Concatenate byte arrays into one buffer. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Constant-length-independent byte equality (used for content addresses). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Lowercase RFC 4648 base32 **without padding** — the multibase `b` alphabet
 * used to render CIDv1 strings. Encodes 5 bits per character, MSB first.
 */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** Decode a padding-free lowercase base32 string back to bytes. */
export function base32Decode(input: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of input) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`base32: invalid character ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bitcoin-style base58btc encoding — the multibase `z` alphabet for `did:key`. */
export function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] as number) << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "";
  // Leading zero bytes are preserved as leading '1's.
  for (const byte of bytes) {
    if (byte === 0) out += BASE58_ALPHABET[0];
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    out += BASE58_ALPHABET[digits[i] as number];
  }
  return out;
}

/** Decode a base58btc string back to bytes. */
export function base58btcDecode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const ch of input) {
    const value = BASE58_ALPHABET.indexOf(ch);
    if (value === -1) throw new Error(`base58: invalid character ${ch}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] as number) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leading = 0;
  for (const ch of input) {
    if (ch === BASE58_ALPHABET[0]) leading++;
    else break;
  }
  const out = new Uint8Array(leading + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[leading + i] = bytes[bytes.length - 1 - i] as number;
  }
  return out;
}

/**
 * URL-safe base64 **without padding** (RFC 4648 §5) — the encoding `did:plc`
 * operations use for their `sig` field.
 */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode an unpadded URL-safe base64 string back to bytes. */
export function base64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Lowercase hex encoding. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Decode a lowercase/uppercase hex string back to bytes. */
export function fromHex(input: string): Uint8Array {
  if (input.length % 2 !== 0) throw new Error("hex: odd-length string");
  // Validate the whole string up front: Number.parseInt is permissive (it parses
  // leading hex digits and silently ignores trailing junk, e.g. "1g" → 1), so a
  // per-slice NaN check would let malformed input through.
  if (!/^[0-9a-fA-F]*$/.test(input)) {
    throw new Error("hex: invalid character");
  }
  const out = new Uint8Array(input.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(input.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
