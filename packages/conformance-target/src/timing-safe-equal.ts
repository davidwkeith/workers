/**
 * Constant-time string comparison to avoid leaking match length (and thus how
 * much of a shared secret an attacker has guessed correctly) via timing.
 * Shared by every admin-token / consent-token check in this package.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
