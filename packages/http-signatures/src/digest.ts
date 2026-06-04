/**
 * Body integrity headers.
 *
 * - `Content-Digest` (RFC 9530) — a structured-field dictionary whose values
 *   are byte sequences, e.g. `sha-256=:<base64>:`.
 * - `Digest` (the legacy RFC 3230 field much of the fediverse still sends),
 *   e.g. `SHA-256=<base64>`.
 *
 * Including a digest in the covered component set is how body tampering is
 * caught: the signature covers the digest header value, and recomputing the
 * digest over the received body proves that value still describes the body.
 */

import { base64ToBytes, bytesToBase64 } from "./base64";

/** Hash algorithms supported for digests. */
export type DigestAlgorithm = "sha-256" | "sha-512";

const SUBTLE_HASH: Record<DigestAlgorithm, string> = {
  "sha-256": "SHA-256",
  "sha-512": "SHA-512",
};

function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

async function hash(
  body: Uint8Array | string,
  alg: DigestAlgorithm,
): Promise<string> {
  const digest = await crypto.subtle.digest(SUBTLE_HASH[alg], toBytes(body));
  return bytesToBase64(new Uint8Array(digest));
}

/**
 * Compute the RFC 9530 `Content-Digest` field value for `body`, e.g.
 * `sha-256=:<base64>:`. The result is meant to be set as the `content-digest`
 * header and listed among the covered components before signing.
 */
export async function createContentDigest(
  body: Uint8Array | string,
  alg: DigestAlgorithm = "sha-256",
): Promise<string> {
  return `${alg}=:${await hash(body, alg)}:`;
}

/**
 * Compute the legacy RFC 3230 `Digest` field value for `body`, e.g.
 * `SHA-256=<base64>` — the spelling fediverse peers expect on the `Digest`
 * header alongside a `draft-cavage` signature.
 */
export async function createDigest(
  body: Uint8Array | string,
  alg: DigestAlgorithm = "sha-256",
): Promise<string> {
  return `${alg.toUpperCase()}=${await hash(body, alg)}`;
}

/** A reason a digest header failed to verify, or `null` when it matched. */
export type DigestRejection =
  | "digest_missing"
  | "digest_unsupported"
  | "digest_mismatch";

/**
 * Verify a received `Content-Digest` field value against `body`. Per RFC 9530
 * §3, entries whose algorithm the verifier does not support are ignored; every
 * supported entry must match, and at least one supported entry must be present
 * (otherwise the value is rejected as `digest_unsupported`).
 */
export async function verifyContentDigest(
  headerValue: string | null | undefined,
  body: Uint8Array | string,
): Promise<DigestRejection | null> {
  if (!headerValue) return "digest_missing";
  let sawSupported = false;
  for (const entry of headerValue.split(",")) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const alg = entry.slice(0, eq).trim().toLowerCase() as DigestAlgorithm;
    if (!(alg in SUBTLE_HASH)) continue;
    const wrapped = entry.slice(eq + 1).trim();
    if (
      !wrapped.startsWith(":") ||
      !wrapped.endsWith(":") ||
      wrapped.length < 2
    ) {
      return "digest_mismatch";
    }
    if (!constantTimeEqualBase64(wrapped.slice(1, -1), await hash(body, alg))) {
      return "digest_mismatch";
    }
    sawSupported = true;
  }
  return sawSupported ? null : "digest_unsupported";
}

/**
 * Verify a received legacy `Digest` field value (`SHA-256=<base64>`, no colon
 * wrapping) against `body`.
 */
export async function verifyDigest(
  headerValue: string | null | undefined,
  body: Uint8Array | string,
): Promise<DigestRejection | null> {
  if (!headerValue) return "digest_missing";
  let sawSupported = false;
  for (const entry of headerValue.split(",")) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const alg = entry.slice(0, eq).trim().toLowerCase() as DigestAlgorithm;
    if (!(alg in SUBTLE_HASH)) continue;
    const value = entry.slice(eq + 1).trim();
    if (!constantTimeEqualBase64(value, await hash(body, alg))) {
      return "digest_mismatch";
    }
    sawSupported = true;
  }
  return sawSupported ? null : "digest_unsupported";
}

/**
 * Compare two base64 strings by their decoded bytes in length-constant time.
 * A malformed encoding compares unequal rather than throwing.
 */
function constantTimeEqualBase64(a: string, b: string): boolean {
  let x: Uint8Array;
  let y: Uint8Array;
  try {
    x = base64ToBytes(a);
    y = base64ToBytes(b);
  } catch {
    return false;
  }
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) {
    diff |= x[i]! ^ y[i]!;
  }
  return diff === 0;
}
