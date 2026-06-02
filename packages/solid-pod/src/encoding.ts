/**
 * base64url + UTF-8 helpers for the edge auth path (JWT/JWKS, DPoP hashing).
 *
 * Dependency-free and runtime-agnostic (Web Crypto / `atob` / `btoa` only) so
 * the surrounding modules unit-test without a Workers runtime.
 */

/** Encode bytes as unpadded base64url (RFC 4648 §5). */
export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode unpadded (or padded) base64url to bytes. */
export function base64urlToBytes(segment: string): Uint8Array {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decode unpadded base64url to a UTF-8 string. */
export function base64urlToText(segment: string): string {
  return new TextDecoder().decode(base64urlToBytes(segment));
}
