/**
 * `@dwk/http-signatures` — HTTP Message Signatures (RFC 9421), with the legacy
 * `draft-cavage-http-signatures` profile for fediverse interop.
 *
 * A pure, runtime-agnostic library: a request reduced to plain data (method,
 * URL, headers) plus a resolved {@link CryptoKey} goes in, a signing result or a
 * {@link VerifyResult} comes out. It performs no I/O beyond Web Crypto, holds no
 * state, and needs no Cloudflare bindings, so it unit-tests without a Workers
 * runtime.
 *
 * It is **protocol-agnostic** — it knows nothing about ActivityPub, IndieWeb, or
 * Solid. Key resolution (fetching an actor's public key, caching it) is the
 * caller's responsibility, supplied as a {@link KeyResolver}. Mirroring the
 * `@dwk/dpop` hardening posture, only asymmetric algorithms from an explicit
 * allow-list are accepted — never `none` or HMAC — and a resolved key is
 * validated against the claimed algorithm (RSA modulus floor, EC curve) before
 * any signature is checked.
 *
 * @see spec/packages/http-signatures.md
 * @packageDocumentation
 */

export { signMessage, type SignParams } from "./sign.js";
export { verifyMessage, type VerifyParams } from "./verify.js";

export type { KeyResolver } from "./rfc9421.js";

export {
  createContentDigest,
  createDigest,
  verifyContentDigest,
  verifyDigest,
  type DigestAlgorithm,
  type DigestRejection,
} from "./digest.js";

export { isSupportedAlgorithm } from "./algorithms.js";

export type {
  HttpMessage,
  SignatureAlgorithm,
  SignatureProfile,
  SignatureFailureReason,
  VerifyResult,
} from "./types.js";
