/**
 * base64url + UTF-8 helpers for the OAuth bearer-token decode path.
 *
 * Dependency-free and runtime-agnostic (`atob` / `btoa` / Web `TextDecoder`
 * only) so the surrounding modules unit-test without a Workers runtime.
 */

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
