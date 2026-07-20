/**
 * HTTP Message Signatures for ActivityPub server-to-server traffic.
 *
 * The fediverse still widely authenticates `POST /inbox` deliveries with the
 * legacy `draft-cavage-http-signatures` "Signature" profile (RSA-SHA256 over a
 * covered header set, body integrity carried by a `Digest` header); this
 * module implements **sign** and **verify** for that profile over WebCrypto
 * directly, with an RSA-only algorithm allow-list mirroring the `@dwk/dpop`
 * hardening posture (no `none`, no symmetric algorithms). Verification also
 * accepts the modern **RFC 9421** `Signature`/`Signature-Input` structured-field
 * profile (e.g. Fedify's `Create`/`Update`/… deliveries), delegated to the
 * cross-standard `@dwk/http-signatures` package (issue #59) rather than
 * reimplemented here — see {@link verifyInboxSignature}.
 *
 * Outbound signing stays on the draft-cavage profile: every fediverse peer
 * this package interoperates with today accepts it, so there is no correctness
 * reason to change it, and it keeps `signRequest` self-contained.
 *
 * Inputs are plain data — method, URL, headers, body bytes, and a resolved key —
 * so the crypto unit-tests without any ActivityPub assumptions.
 */

import {
  verifyMessage,
  type HttpMessage,
  type KeyResolver as HttpSigKeyResolver,
  type SignatureFailureReason,
} from "@dwk/http-signatures";

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
  /** Path + query the signer covered via `(request-target)` (draft-cavage). */
  readonly path: string;
  /**
   * The full absolute request URL, e.g. `https://example.com/users/bob/inbox`.
   * Only used for RFC 9421 verification (`@target-uri`/`@authority`/…); the
   * draft-cavage path only ever needs {@link path}.
   */
  readonly url: string;
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
 * Verify an inbound `POST /inbox` HTTP signature — draft-cavage or RFC 9421,
 * auto-detected the same way `@dwk/http-signatures` does: a `Signature-Input`
 * header means RFC 9421, its absence means draft-cavage. Both profiles bind
 * the same facts — the target, a timestamp, and the body — before an
 * RSA-SHA256 verification against the resolved key. On success both return the
 * verified `keyId` and its owning actor IRI for the front door to hand to the
 * DO.
 */
export async function verifyInboxSignature(
  request: InboxRequest,
  resolveKey: KeyResolver,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  if (request.headers.has("signature-input")) {
    return verifyInboxSignatureRfc9421(request, resolveKey, options);
  }
  return verifyInboxSignatureCavage(request, resolveKey, options);
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
async function verifyInboxSignatureCavage(
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

/** Flatten a `Headers` object into the plain record `@dwk/http-signatures` expects. */
function headersRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) out[key] = value;
  return out;
}

/**
 * Map a `@dwk/http-signatures` failure reason onto this package's own
 * {@link VerifyFailureReason} vocabulary, so callers (structured logging, the
 * diagnostic block, tests) only ever see one stable set of reasons regardless
 * of which profile rejected the request. `importFailed` distinguishes a
 * `key_unresolved` the library reported because our own PEM import threw
 * (`bad_key`, matching the draft-cavage path) from a genuine resolver miss.
 */
function mapRfc9421Reason(
  reason: SignatureFailureReason,
  importFailed: boolean,
): VerifyFailureReason {
  switch (reason) {
    case "key_unresolved":
      return importFailed ? "bad_key" : "key_unresolved";
    case "key_alg_mismatch":
    case "key_too_small":
    case "key_invalid":
      return "bad_key";
    case "signature_invalid":
      return "signature_invalid";
    case "digest_mismatch":
      return "digest_mismatch";
    case "digest_missing":
    case "digest_unsupported":
      return "missing_digest";
    case "alg_unsupported":
      return "unsupported_algorithm";
    case "components_malformed":
    case "covered_component_missing":
    case "required_component_missing":
      return "missing_covered_header";
    case "created_required":
    case "created_invalid":
    case "expires_invalid":
    case "signature_expired":
    case "signature_future":
      return "stale_date";
    case "signature_missing":
    case "signature_input_malformed":
    case "signature_malformed":
    case "label_ambiguous":
    case "label_missing":
    case "keyid_missing":
    default:
      return "missing_signature";
  }
}

/**
 * Verify an RFC 9421 (`Signature-Input`/`Signature`) HTTP signature on an
 * inbound `POST /inbox`, delegating the wire-format parsing and cryptographic
 * verification to `@dwk/http-signatures`. Requires `@method`, `@target-uri`,
 * and `content-digest` to be covered (binding the method, the full target URL
 * — host included — and the body under the signature) and a `created`
 * parameter (the RFC 9421-idiomatic timestamp anchor, checked against the same
 * clock-skew tolerance the draft-cavage path applies to the legacy `Date`
 * header) so a captured signature cannot be replayed indefinitely.
 */
async function verifyInboxSignatureRfc9421(
  request: InboxRequest,
  resolveKey: KeyResolver,
  options: VerifyOptions,
): Promise<VerifyResult> {
  let resolvedOwner: string | null = null;
  let importFailed = false;
  const libResolveKey: HttpSigKeyResolver = async ({ keyId }) => {
    if (keyId === null) return null;
    const resolved = await resolveKey(keyId);
    if (!resolved) return null;
    resolvedOwner = resolved.owner;
    try {
      return await importPublicKey(resolved.publicKeyPem);
    } catch {
      importFailed = true;
      return null;
    }
  };

  const message: HttpMessage = {
    method: request.method,
    url: request.url,
    headers: headersRecord(request.headers),
  };
  const now = options.now ?? (() => Date.now());

  const result = await verifyMessage(message, {
    profile: "rfc9421",
    resolveKey: libResolveKey,
    requiredComponents: ["@method", "@target-uri", "content-digest"],
    requireCreated: true,
    now: Math.floor(now() / 1000),
    toleranceSeconds: options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS,
    body: request.body,
  });

  if (!result.valid) {
    return {
      ok: false,
      reason: mapRfc9421Reason(
        result.reason ?? "signature_invalid",
        importFailed,
      ),
    };
  }
  // The library only rejects a `created` that is too far in the *future*
  // (`signature_future`) — it never bounds staleness in the other direction
  // unless the signer also sent `expires`, which is not something we can rely
  // on every peer to include. Enforce the same two-sided replay window here
  // that the draft-cavage path enforces on the literal `Date` header, keyed
  // off the verified `created` instead.
  const toleranceMs =
    (options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS) * 1000;
  if (
    result.created === undefined ||
    Math.abs(now() - result.created * 1000) > toleranceMs
  ) {
    return { ok: false, reason: "stale_date" };
  }
  // A valid result always carries the keyid it verified against, and our own
  // resolver ran (and recorded the owner) to get here — but guard defensively
  // rather than assert, since a `!` would crash on any future library change.
  if (!resolvedOwner || !result.keyId) {
    return { ok: false, reason: "key_unresolved" };
  }
  return { ok: true, keyId: result.keyId, actor: resolvedOwner };
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
