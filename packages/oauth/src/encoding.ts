/**
 * base64url + random-identifier helpers.
 *
 * Kept dependency-free and runtime-agnostic (Web Crypto / `btoa` only) so the
 * surrounding modules unit-test without a Workers runtime.
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

/**
 * A cryptographically-random unpadded-base64url identifier of `bytes` entropy
 * (default 32 bytes = 256 bits). Used for `request_uri` references, generated
 * `client_id`s, and client secrets, where unguessability is the security
 * property.
 */
export function randomIdentifier(bytes = 32): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
