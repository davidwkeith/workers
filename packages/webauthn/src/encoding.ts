/**
 * Byte / base64url encoding helpers shared across the WebAuthn ceremonies.
 *
 * WebAuthn transports binary fields (challenges, credential ids, signatures,
 * attestation objects) as base64url over JSON, so every ceremony boundary needs
 * the same encode/decode pair. These are pure and runtime-agnostic — Web APIs
 * (`atob`/`btoa`/`TextEncoder`) only.
 */

/** Decode a base64url (or padded base64) string to raw bytes. */
export function base64urlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encode raw bytes as an unpadded base64url string. */
export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Strip any base64 padding and normalize base64 to base64url so two encodings
 * of the same bytes compare equal. WebAuthn clients emit the challenge in
 * `clientDataJSON` as unpadded base64url; this lets a comparison tolerate a
 * padded or `+`/`/`-alphabet copy without a full decode/re-encode round trip.
 */
export function normalizeBase64url(input: string): string {
  return input.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
}

/** Whether two byte arrays are equal (length + contents). Not constant-time. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Constant-time string comparison via the Workers runtime's
 * `crypto.subtle.timingSafeEqual`. Unlike `bytesEqual`, this must not
 * short-circuit on a length mismatch (that itself leaks the length via
 * timing) — compare the value against itself instead, per Cloudflare's
 * documented safe pattern.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bytesA = utf8ToBytes(a);
  const bytesB = utf8ToBytes(b);
  const lengthsMatch = bytesA.byteLength === bytesB.byteLength;
  return lengthsMatch
    ? crypto.subtle.timingSafeEqual(bytesA, bytesB)
    : !crypto.subtle.timingSafeEqual(bytesA, bytesA);
}

/** SHA-256 digest of the input bytes as a fresh `Uint8Array`. */
export async function sha256(input: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", input as BufferSource);
  return new Uint8Array(digest);
}

/** UTF-8 encode a string to bytes. */
export function utf8ToBytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

/** UTF-8 decode bytes to a string. */
export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
