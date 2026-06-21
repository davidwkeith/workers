/**
 * The unified verification entry point. Auto-detects the wire profile (unless
 * one is forced), verifies the signature, and — when a body is supplied —
 * checks any covered `content-digest` / `digest` against it so body tampering
 * is caught alongside header tampering.
 */

import { verifyCavage } from "./cavage.js";
import { verifyContentDigest, verifyDigest } from "./digest.js";
import { verifyRfc9421, type KeyResolver } from "./rfc9421.js";
import type { HttpMessage, SignatureProfile, VerifyResult } from "./types.js";

/** Inputs for {@link verifyMessage}. */
export interface VerifyParams {
  /** Resolves the public {@link CryptoKey} for a `keyid` (and, when known, `alg`). */
  resolveKey: KeyResolver;
  /** Force a profile. When omitted, it is detected from the present headers. */
  profile?: SignatureProfile;
  /** Which labelled signature to verify (RFC 9421); required if more than one. */
  label?: string;
  /** Component identifiers that MUST be covered (e.g. `@method`, `date`, `content-digest`). */
  requiredComponents?: string[];
  /** Require a `created` parameter (RFC 9421). */
  requireCreated?: boolean;
  /** Current time, epoch seconds. Defaults to `Date.now()`. */
  now?: number;
  /** Allowed clock skew, in seconds, for `created`/`expires`. Defaults to 300. */
  toleranceSeconds?: number;
  /**
   * The received body. When provided and a digest component is covered, the
   * corresponding `content-digest` / `digest` header is recomputed over it; a
   * mismatch fails verification with a `digest_*` reason.
   */
  body?: Uint8Array | string;
}

function hasHeader(message: HttpMessage, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(message.headers).some((k) => k.toLowerCase() === lower);
}

function getHeader(message: HttpMessage, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(message.headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v.join(", ") : v;
  }
  return null;
}

/**
 * Verify the HTTP message signature on `message`. Never throws — every failure
 * is `{ valid: false, reason }` with a stable {@link SignatureFailureReason}.
 */
export async function verifyMessage(
  message: HttpMessage,
  params: VerifyParams,
): Promise<VerifyResult> {
  const profile: SignatureProfile =
    params.profile ??
    (hasHeader(message, "signature-input") ? "rfc9421" : "cavage");

  const result =
    profile === "rfc9421"
      ? await verifyRfc9421(message, {
          resolveKey: params.resolveKey,
          label: params.label,
          requiredComponents: params.requiredComponents,
          requireCreated: params.requireCreated,
          now: params.now,
          toleranceSeconds: params.toleranceSeconds,
        })
      : await verifyCavage(message, {
          resolveKey: params.resolveKey,
          requiredComponents: params.requiredComponents,
          now: params.now,
          toleranceSeconds: params.toleranceSeconds,
        });

  if (!result.valid || params.body === undefined) return result;

  // Body integrity: only when a digest component was actually covered.
  const covered = new Set(
    (result.coveredComponents ?? []).map((c) => c.toLowerCase()),
  );
  if (covered.has("content-digest")) {
    const rejection = await verifyContentDigest(
      getHeader(message, "content-digest"),
      params.body,
    );
    if (rejection !== null)
      return { ...result, valid: false, reason: rejection };
  } else if (covered.has("digest")) {
    const rejection = await verifyDigest(
      getHeader(message, "digest"),
      params.body,
    );
    if (rejection !== null)
      return { ...result, valid: false, reason: rejection };
  }

  return result;
}
