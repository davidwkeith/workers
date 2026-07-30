/**
 * Constant-time string comparison via the Workers runtime's
 * `crypto.subtle.timingSafeEqual`. Do not short-circuit on length — looping
 * only to `Math.min(a.length, b.length)` leaks the shorter length via
 * timing; compare the value against itself instead when lengths differ, per
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
