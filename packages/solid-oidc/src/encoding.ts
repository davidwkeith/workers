/**
 * base64url + hashing helpers shared across the OP's PKCE, JWS, and code-store
 * paths. Dependency-free (Web Crypto / `atob` / `btoa` only).
 *
 * @packageDocumentation
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

/** Encode a UTF-8 string as unpadded base64url. */
export function textToBase64url(text: string): string {
  return bytesToBase64url(new TextEncoder().encode(text));
}

/** `base64url(SHA-256(input))` over a UTF-8 string. */
export async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return bytesToBase64url(new Uint8Array(digest));
}

/** Hex `SHA-256(input)` over a UTF-8 string (for hashing codes/tokens at rest). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison. Returns `false` early only on length
 * mismatch; otherwise compares every character so timing does not leak how
 * much of a secret matched.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A cryptographically-random 256-bit value as base64url (codes, jti). */
export function randomToken(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
}
