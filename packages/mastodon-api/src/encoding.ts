/** Token minting, hashing, and PKCE helpers (Web Crypto only). */

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** A 256-bit random base64url identifier (tokens, codes, client ids). */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** SHA-256 of a UTF-8 string as lowercase hex (token/secret storage form). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** RFC 7636 §4.6: `challenge === BASE64URL(SHA256(verifier))`. */
export async function verifyPkceS256(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  return base64Url(new Uint8Array(digest)) === challenge;
}

/** Whether `hex` is a well-formed, even-length hex string. */
function isValidHex(hex: string): boolean {
  return hex.length % 2 === 0 && /^[0-9a-f]*$/i.test(hex);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Constant-time comparison of two hex digests via the Workers runtime's
 * `crypto.subtle.timingSafeEqual`. Do not short-circuit on length — that
 * itself leaks length via timing; compare the value against itself instead
 * when lengths differ, per Cloudflare's documented safe pattern.
 *
 * A malformed *format* (odd length, or a non-hex character) is not itself a
 * secret, so it is safe to reject up front rather than feeding it through
 * `hexToBytes` — which would otherwise silently truncate an odd-length input
 * and coerce invalid characters to `0`, letting two different strings (e.g.
 * `"abcd"`/`"abcde"`, or `"zz"`/`"zy"`) compare equal.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (!isValidHex(a) || !isValidHex(b) || a.length !== b.length) return false;
  const bytesA = hexToBytes(a);
  const bytesB = hexToBytes(b);
  return crypto.subtle.timingSafeEqual(bytesA, bytesB);
}
