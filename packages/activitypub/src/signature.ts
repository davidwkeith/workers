/**
 * HTTP Message Signatures for ActivityPub server-to-server traffic.
 *
 * The fediverse authenticates `POST /inbox` deliveries with the legacy
 * `draft-cavage-http-signatures` "Signature" profile (RSA-SHA256 over a covered
 * header set, with body integrity carried by a `Digest` header). This module
 * implements **sign** and **verify** for that profile over WebCrypto, with an
 * RSA-only algorithm allow-list mirroring the `@dwk/dpop` hardening posture (no
 * `none`, no symmetric algorithms).
 *
 * It is deliberately small and self-contained so the package functions and
 * federates today; it is structured behind the `verifyInboxSignature` config
 * seam (see `config.ts`) so the forthcoming cross-standard `@dwk/http-signatures`
 * package (RFC 9421 + draft-cavage; issue #59) can be swapped in unchanged once
 * it lands.
 *
 * Inputs are plain data — method, URL, headers, body bytes, and a resolved key —
 * so the crypto unit-tests without any ActivityPub assumptions.
 */

/** The only signature algorithm v1 accepts (RSASSA-PKCS1-v1_5 + SHA-256). */
const ALGORITHM = "rsa-sha256";

const RSA_PARAMS = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
} as const;

/** Default tolerance (seconds) for clock skew on the signed `Date` header. */
export const DEFAULT_CLOCK_SKEW_SECONDS = 300;

/** Decode a base64 string to bytes. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode bytes to a base64 string. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

/** Strip a PEM envelope (`-----BEGIN …-----`) to its base64 DER payload. */
function pemBody(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
}

/** Import an SPKI (public) RSA key from PEM for signature verification. */
export async function importPublicKey(pem: string): Promise<CryptoKey> {
  const der = base64ToBytes(pemBody(pem));
  return crypto.subtle.importKey(
    "spki",
    der as BufferSource,
    RSA_PARAMS,
    false,
    ["verify"],
  );
}

/** Import a PKCS#8 (private) RSA key from PEM for signing. */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = base64ToBytes(pemBody(pem));
  return crypto.subtle.importKey(
    "pkcs8",
    der as BufferSource,
    RSA_PARAMS,
    false,
    ["sign"],
  );
}

/** Compute the `Digest` header value (`SHA-256=<base64>`) for a body. */
export async function digestHeader(body: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", body as BufferSource);
  return `SHA-256=${bytesToBase64(new Uint8Array(hash))}`;
}

/** Parse the comma-separated `key="value"` pairs of a `Signature` header. */
export function parseSignatureHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Values are quoted strings; split on commas that are followed by `key=`.
  const re = /([a-zA-Z]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(header)) !== null) {
    const key = match[1] as string;
    const value = match[2] as string;
    out[key] = value;
  }
  return out;
}

/**
 * Reconstruct the draft-cavage signing string from the covered-component list.
 * `(request-target)` expands to `"<method-lowercase> <path-and-query>"`; every
 * other token is the lowercased request header's value. A listed component with
 * no corresponding header value makes the base unconstructable (`null`).
 */
export function buildSigningString(
  coveredHeaders: readonly string[],
  parts: {
    readonly method: string;
    readonly path: string;
    readonly headers: Headers;
  },
): string | null {
  const lines: string[] = [];
  for (const name of coveredHeaders) {
    if (name === "(request-target)") {
      lines.push(
        `(request-target): ${parts.method.toLowerCase()} ${parts.path}`,
      );
      continue;
    }
    const value = parts.headers.get(name);
    if (value === null) return null;
    lines.push(`${name}: ${value}`);
  }
  return lines.join("\n");
}

/** A resolved verification key plus the actor IRI that owns it. */
export interface ResolvedKey {
  /** The actor IRI that owns the key (`publicKey.owner`). */
  readonly owner: string;
  /** PEM-encoded SPKI public key. */
  readonly publicKeyPem: string;
}

/** Resolve a `keyId` to its owning actor + PEM public key (caller-supplied). */
export type KeyResolver = (
  keyId: string,
) => Promise<ResolvedKey | null> | ResolvedKey | null;

/** Machine-readable reason an inbound signature was rejected. */
export type VerifyFailureReason =
  | "missing_signature"
  | "unsupported_algorithm"
  | "missing_covered_header"
  | "unconstructable_base"
  | "missing_digest"
  | "digest_mismatch"
  | "stale_date"
  | "key_unresolved"
  | "bad_key"
  | "signature_invalid";

/** Outcome of {@link verifyInboxSignature}. */
export type VerifyResult =
  | { readonly ok: true; readonly keyId: string; readonly actor: string }
  | { readonly ok: false; readonly reason: VerifyFailureReason };

/** What {@link verifyInboxSignature} needs about the inbound request. */
export interface InboxRequest {
  readonly method: string;
  /** Path + query the signer covered via `(request-target)`. */
  readonly path: string;
  readonly headers: Headers;
  /** The already-buffered request body (inbox bodies are small). */
  readonly body: Uint8Array;
}

/** Tunables for {@link verifyInboxSignature}. */
export interface VerifyOptions {
  readonly clockSkewSeconds?: number;
  readonly now?: () => number;
}

/**
 * Verify a draft-cavage HTTP signature on an inbound `POST /inbox`.
 *
 * Checks, in order: a supported algorithm; that `(request-target)`, `host`,
 * `date`, and `digest` are all covered (so neither the target nor the body can
 * be swapped under the signature); that the `Digest` matches the body; that the
 * signed `Date` is within the skew window (replay bound); then the RSA
 * signature itself against the resolved key. On success it returns the verified
 * `keyId` and its owning actor IRI for the front door to hand to the DO.
 */
export async function verifyInboxSignature(
  request: InboxRequest,
  resolveKey: KeyResolver,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const sigHeader = request.headers.get("signature");
  if (!sigHeader) return { ok: false, reason: "missing_signature" };

  const fields = parseSignatureHeader(sigHeader);
  const keyId = fields.keyId;
  const signatureB64 = fields.signature;
  if (!keyId || !signatureB64)
    return { ok: false, reason: "missing_signature" };

  const algorithm = (fields.algorithm ?? ALGORITHM).toLowerCase();
  // `hs2019` is the RFC-era opaque label; we still only do RSA-SHA256 underneath.
  if (algorithm !== ALGORITHM && algorithm !== "hs2019")
    return { ok: false, reason: "unsupported_algorithm" };

  const covered = (fields.headers ?? "(request-target) host date")
    .toLowerCase()
    .split(/\s+/)
    .filter((h) => h.length > 0);

  // The covered set MUST bind the target, the body, and a timestamp; otherwise a
  // valid signature could be lifted onto a different request or a stale one.
  for (const required of ["(request-target)", "host", "date", "digest"]) {
    if (!covered.includes(required))
      return { ok: false, reason: "missing_covered_header" };
  }

  const expectedDigest = await digestHeader(request.body);
  const presentedDigest = request.headers.get("digest");
  if (!presentedDigest) return { ok: false, reason: "missing_digest" };
  if (!digestsEqual(presentedDigest, expectedDigest))
    return { ok: false, reason: "digest_mismatch" };

  const dateHeader = request.headers.get("date");
  if (!dateHeader || !dateWithinSkew(dateHeader, options))
    return { ok: false, reason: "stale_date" };

  const signingString = buildSigningString(covered, request);
  if (signingString === null)
    return { ok: false, reason: "unconstructable_base" };

  const resolved = await resolveKey(keyId);
  if (!resolved) return { ok: false, reason: "key_unresolved" };

  let key: CryptoKey;
  try {
    key = await importPublicKey(resolved.publicKeyPem);
  } catch {
    return { ok: false, reason: "bad_key" };
  }

  let signature: Uint8Array;
  try {
    signature = base64ToBytes(signatureB64);
  } catch {
    return { ok: false, reason: "signature_invalid" };
  }

  const verified = await crypto.subtle.verify(
    RSA_PARAMS.name,
    key,
    signature as BufferSource,
    new TextEncoder().encode(signingString) as BufferSource,
  );
  if (!verified) return { ok: false, reason: "signature_invalid" };

  return { ok: true, keyId, actor: resolved.owner };
}

/** A signed outbound request: the headers to send plus the body to send them with. */
export interface SignedRequest {
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

/** Material needed to sign an outbound delivery. */
export interface SignerKey {
  /** The `keyId` published in the actor document (`<actor>#main-key`). */
  readonly keyId: string;
  /** PEM-encoded PKCS#8 private key. */
  readonly privateKeyPem: string;
}

/**
 * Sign an outbound `POST` (a delivery to a remote inbox) with the draft-cavage
 * profile. Computes the body `Digest`, covers
 * `(request-target) host date digest content-type`, and returns the full header
 * set — `Host`, `Date`, `Digest`, `Content-Type`, and `Signature` — to send.
 */
export async function signRequest(
  url: string,
  body: Uint8Array,
  signer: SignerKey,
  options: { readonly now?: () => number; readonly contentType?: string } = {},
): Promise<SignedRequest> {
  const now = options.now ?? (() => Date.now());
  const target = new URL(url);
  const path = `${target.pathname}${target.search}`;
  const contentType = options.contentType ?? "application/activity+json";
  const date = new Date(now()).toUTCString();
  const digest = await digestHeader(body);

  const headers = new Headers({
    host: target.host,
    date,
    digest,
    "content-type": contentType,
  });
  const covered = [
    "(request-target)",
    "host",
    "date",
    "digest",
    "content-type",
  ];
  const signingString = buildSigningString(covered, {
    method: "post",
    path,
    headers,
  });
  // The covered headers are all set above, so the base is always constructable.
  const key = await importPrivateKey(signer.privateKeyPem);
  const raw = await crypto.subtle.sign(
    RSA_PARAMS.name,
    key,
    new TextEncoder().encode(signingString as string) as BufferSource,
  );
  const signatureB64 = bytesToBase64(new Uint8Array(raw));
  const signatureHeader =
    `keyId="${signer.keyId}",algorithm="${ALGORITHM}",` +
    `headers="${covered.join(" ")}",signature="${signatureB64}"`;

  return {
    headers: {
      Host: target.host,
      Date: date,
      Digest: digest,
      "Content-Type": contentType,
      Signature: signatureHeader,
    },
    body,
  };
}

/** Compare two `Digest` header values for the `SHA-256` algorithm. */
function digestsEqual(presented: string, expected: string): boolean {
  // A peer may send multiple algorithms; match the SHA-256 component only.
  const want = expected.slice("SHA-256=".length);
  for (const part of presented.split(",")) {
    const trimmed = part.trim();
    if (/^sha-256=/i.test(trimmed)) {
      return trimmed.slice("SHA-256=".length) === want;
    }
  }
  return false;
}

/** Whether a signed `Date` header is within the accepted skew of now. */
function dateWithinSkew(dateHeader: string, options: VerifyOptions): boolean {
  const signed = Date.parse(dateHeader);
  if (Number.isNaN(signed)) return false;
  const now = (options.now ?? (() => Date.now()))();
  const skewMs =
    (options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS) * 1000;
  return Math.abs(now - signed) <= skewMs;
}
