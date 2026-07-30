/**
 * base64url + UTF-8 helpers shared by the PKCE and access-token code paths.
 *
 * Kept dependency-free and runtime-agnostic (Web Crypto / `atob` / `btoa` only)
 * so the surrounding modules unit-test without a Workers runtime.
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

/** Decode unpadded base64url to a UTF-8 string. */
export function base64urlToText(segment: string): string {
  return new TextDecoder().decode(base64urlToBytes(segment));
}

/** `base64url(SHA-256(input))` over a UTF-8 string. */
export async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return bytesToBase64url(new Uint8Array(digest));
}

/**
 * Constant-time string comparison via the Workers runtime's
 * `crypto.subtle.timingSafeEqual`. Used for PKCE challenge and HMAC
 * signature checks — do not short-circuit on length mismatch, which itself
 * leaks length via timing; compare the value against itself instead, per
 * Cloudflare's documented safe pattern.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  const lengthsMatch = bytesA.byteLength === bytesB.byteLength;
  return lengthsMatch
    ? crypto.subtle.timingSafeEqual(bytesA, bytesB)
    : !crypto.subtle.timingSafeEqual(bytesA, bytesA);
}
