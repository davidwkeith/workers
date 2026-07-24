/**
 * PKCE (RFC 7636) — S256 only. `plain` is deliberately unsupported: a public
 * client on the open web gains nothing from an unhashed challenge, and Solid
 * clients are expected to use S256.
 *
 * @packageDocumentation
 */

import { sha256Base64url, timingSafeEqual } from "./encoding.js";

/** RFC 7636 §4.1 `code_verifier` charset + length. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
/** A `code_challenge` is a base64url SHA-256 digest: 43 chars, no padding. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Whether a string is a well-formed S256 `code_challenge`. */
export function isValidChallenge(challenge: string): boolean {
  return CHALLENGE_RE.test(challenge);
}

/**
 * Verify a PKCE S256 `code_verifier` against the stored `code_challenge`:
 * `base64url(SHA-256(verifier)) === challenge`, compared in constant time.
 * A malformed verifier fails without hashing.
 */
export async function verifyPkce(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  if (!VERIFIER_RE.test(verifier)) return false;
  const computed = await sha256Base64url(verifier);
  return timingSafeEqual(computed, challenge);
}
