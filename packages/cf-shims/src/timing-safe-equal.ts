/**
 * Install a Node `crypto.subtle.timingSafeEqual` method.
 *
 * `crypto.subtle.timingSafeEqual` is a real, synchronous `SubtleCrypto`
 * extension — but it is Cloudflare-Workers-proprietary, not a WHATWG/W3C Web
 * Crypto API. Several endpoint packages (`@dwk/indieauth`, `@dwk/webauthn`,
 * `@dwk/mastodon-api`, `@dwk/conformance-target`) use it for constant-time
 * PKCE/HMAC/challenge/client-secret comparisons, per Cloudflare's documented
 * safe pattern of comparing a value against itself on a length mismatch
 * rather than short-circuiting (which would otherwise leak length via
 * timing). Node has no such method (`crypto.subtle.timingSafeEqual` is
 * `undefined`), so a package composed into `@dwk/server` (the Node
 * self-hosting host) throws a `TypeError` calling it — this polyfill closes
 * that gap with a pure-JS constant-time comparison, idempotent and a no-op
 * where a native implementation already exists (workerd, or a
 * deployer-installed one).
 *
 * @see spec/self-hosting.md §7.5
 * @see spec/portability.md
 */

/** Read-only view of the bytes behind an `ArrayBuffer` or a typed-array view. */
function toUint8Array(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  return input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

/**
 * Constant-time byte comparison matching `crypto.subtle.timingSafeEqual`'s
 * real signature and behavior: throws on unequal-length inputs (mirroring
 * the real API), and otherwise compares every byte via an XOR accumulator so
 * the comparison takes the same time regardless of where a mismatch occurs.
 */
function timingSafeEqual(
  a: ArrayBuffer | ArrayBufferView,
  b: ArrayBuffer | ArrayBufferView,
): boolean {
  const bytesA = toUint8Array(a);
  const bytesB = toUint8Array(b);
  if (bytesA.byteLength !== bytesB.byteLength) {
    throw new TypeError(
      "timingSafeEqual: input ArrayBuffers must have the same byte length",
    );
  }
  let diff = 0;
  for (let i = 0; i < bytesA.byteLength; i += 1) {
    diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  }
  return diff === 0;
}

/** Install `crypto.subtle.timingSafeEqual` if one is not already present. */
export function installTimingSafeEqual(): void {
  const subtle = crypto.subtle as unknown as {
    timingSafeEqual?: typeof timingSafeEqual;
  };
  subtle.timingSafeEqual ??= timingSafeEqual;
}
