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

/**
 * Constant-time comparison for equal-length hex digests, so secret checks
 * don't leak match length. Unequal lengths return `false` immediately —
 * digest lengths are public.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
