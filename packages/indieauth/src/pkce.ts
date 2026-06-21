/**
 * PKCE (RFC 7636) verification. IndieAuth requires PKCE on the authorization
 * code flow, and this server only accepts the `S256` challenge method — `plain`
 * is deliberately unsupported.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7636
 */

import { sha256Base64url, timingSafeEqual } from "./encoding.js";

/** The only PKCE challenge method this server accepts. */
export const SUPPORTED_CODE_CHALLENGE_METHODS = ["S256"] as const;

/** A PKCE `code_challenge_method` value. */
export type CodeChallengeMethod =
  (typeof SUPPORTED_CODE_CHALLENGE_METHODS)[number];

/** Unreserved characters permitted in a `code_verifier` (RFC 7636 §4.1). */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** Whether `method` is a challenge method this server supports. */
export function isSupportedChallengeMethod(
  method: string,
): method is CodeChallengeMethod {
  return (SUPPORTED_CODE_CHALLENGE_METHODS as readonly string[]).includes(
    method,
  );
}

/**
 * Verify a PKCE `code_verifier` against the stored `code_challenge`.
 *
 * Computes `base64url(SHA-256(code_verifier))` and compares it to the stored
 * challenge in constant time. Rejects verifiers outside the RFC 7636 length and
 * character constraints, and any method other than `S256`.
 */
export async function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string,
): Promise<boolean> {
  if (!isSupportedChallengeMethod(method)) return false;
  if (!CODE_VERIFIER_PATTERN.test(codeVerifier)) return false;
  const computed = await sha256Base64url(codeVerifier);
  return timingSafeEqual(computed, codeChallenge);
}
