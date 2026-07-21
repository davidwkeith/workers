/**
 * `@dwk/dpop` — DPoP (RFC 9449) proof verification.
 *
 * A pure, runtime-agnostic library: HTTP request facts and token claims go in,
 * a verification result comes out. It performs no I/O beyond Web Crypto, holds
 * no state, and needs no Cloudflare bindings, so it unit-tests without a
 * Workers runtime.
 *
 * The library stays protocol-agnostic — it knows nothing about IndieAuth or
 * Solid. The caller supplies the request facts and any access-token binding it
 * expects, and owns replay detection via the returned `jti`.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9449
 * @see spec/packages/dpop.md
 * @packageDocumentation
 */

/** Default clock-skew window (seconds) applied to `iat` when none is given. */
export const DEFAULT_MAX_AGE_SECONDS = 300;

/**
 * Asymmetric signature algorithms accepted in the DPoP proof JOSE header.
 *
 * Symmetric (`HS*`) and `none` are deliberately excluded: a DPoP proof must be
 * signed by the client-held private key whose public half is embedded as `jwk`.
 * `EdDSA`/`ES512` are simply not implemented yet — no deliberate security
 * reason excludes them, unlike the symmetric/`none` exclusion above; widen
 * this allow-list if a caller needs one of them.
 */
export type DpopAlgorithm = "ES256" | "ES384" | "RS256" | "PS256";

/** Stable, locale-independent failure codes returned in {@link DpopVerifyResult.reason}. */
export type DpopFailureReason =
  | "proof_malformed"
  | "header_invalid"
  | "payload_invalid"
  | "typ_invalid"
  | "crit_unsupported"
  | "alg_unsupported"
  | "jwk_missing"
  | "jwk_private"
  | "jwk_invalid"
  | "crv_mismatch"
  | "rsa_key_too_small"
  | "signature_invalid"
  | "htm_mismatch"
  | "htu_invalid"
  | "htu_mismatch"
  | "iat_invalid"
  | "proof_expired"
  | "proof_future"
  | "jti_missing"
  | "nonce_mismatch"
  | "ath_mismatch"
  | "jkt_required"
  | "jkt_mismatch";

/** Plain-data inputs required to verify a DPoP proof. */
export interface DpopVerifyInput {
  /** The DPoP proof JWT (compact JWS) from the `DPoP` header. */
  proof: string;
  /** HTTP method of the request the proof is bound to, e.g. `"POST"`. */
  htm: string;
  /** HTTP target URI of the request (query/fragment are ignored per §4.3). */
  htu: string;
  /**
   * Expected access-token hash binding (Resource Server case). When provided,
   * the proof MUST carry an `ath` claim equal to `base64url(SHA-256(accessToken))`.
   *
   * A Resource Server enforcing `ath` MUST also supply {@link expectedJkt}: the
   * `ath` proves the proof was made for this token, but only the `cnf.jkt`
   * binding proves the proof key is the one the token was issued to. Passing
   * `accessToken` without `expectedJkt` defeats proof-of-possession
   * (RFC 9449 §7.1) and is rejected with `jkt_required` rather than validating.
   */
  accessToken?: string;
  /**
   * Token confirmation thumbprint (`cnf.jkt`) to match against the proof key.
   * Required whenever {@link accessToken} is supplied (see its note).
   */
  expectedJkt?: string;
  /**
   * Server-provided DPoP nonce the proof must carry (RFC 9449 §8/§9). When set,
   * the proof MUST carry a `nonce` claim equal to this value, else it is
   * rejected with `nonce_mismatch`. An AS/RS uses this to bound proof lifetime
   * and force fresh proofs as a replay defense: on a mismatch (or when no nonce
   * was sent yet) the caller answers with a `use_dpop_nonce` error carrying a
   * fresh `DPoP-Nonce`. Issuing and rotating the nonce is the caller's job; this
   * library only checks equality and surfaces the proof's {@link DpopVerifyResult.nonce}.
   */
  expectedNonce?: string;
  /** Current time in seconds since the epoch. Defaults to `Date.now()`. */
  now?: number;
  /** Allowed clock skew in seconds for the `iat` window. Defaults to {@link DEFAULT_MAX_AGE_SECONDS}. */
  maxAgeSeconds?: number;
}

/** Result of verifying a DPoP proof. */
export interface DpopVerifyResult {
  /** Whether the proof is valid. */
  valid: boolean;
  /** The verified JWT ID (`jti`) for replay detection by the caller. */
  jti?: string;
  /** The RFC 7638 thumbprint of the proof key (`jkt`). */
  jkt?: string;
  /**
   * The proof's `nonce` claim, when it carried one (string only). Surfaced on
   * both success and a `nonce_mismatch` so a caller enforcing the
   * `DPoP-Nonce` mechanism (RFC 9449 §8/§9) can decide whether to answer with a
   * `use_dpop_nonce` error and a fresh nonce.
   */
  nonce?: string;
  /** Stable failure code (see {@link DpopFailureReason}) when `valid` is false. */
  reason?: DpopFailureReason;
}

// Structural shapes for the Web Crypto algorithm parameters. We avoid the
// standard DOM lib names (EcKeyImportParams, EcdsaParams, …) because
// @cloudflare/workers-types does not declare them; these objects are accepted
// structurally by crypto.subtle.importKey / verify.
interface ImportAlg {
  name: string;
  namedCurve?: string;
  hash?: string;
}
interface VerifyAlg {
  name: string;
  hash?: string;
  saltLength?: number;
}

interface AlgSpec {
  kty: "EC" | "RSA";
  /** For EC algorithms, the curve the `alg` implies (`jwk.crv` must match it). */
  expectedCrv?: string;
  importParams: ImportAlg;
  verifyParams: VerifyAlg;
}

const ALGS: Record<DpopAlgorithm, AlgSpec> = {
  ES256: {
    kty: "EC",
    expectedCrv: "P-256",
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    verifyParams: { name: "ECDSA", hash: "SHA-256" },
  },
  ES384: {
    kty: "EC",
    expectedCrv: "P-384",
    importParams: { name: "ECDSA", namedCurve: "P-384" },
    verifyParams: { name: "ECDSA", hash: "SHA-384" },
  },
  RS256: {
    kty: "RSA",
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verifyParams: { name: "RSASSA-PKCS1-v1_5" },
  },
  PS256: {
    kty: "RSA",
    importParams: { name: "RSA-PSS", hash: "SHA-256" },
    verifyParams: { name: "RSA-PSS", saltLength: 32 },
  },
};

/**
 * Minimum accepted RSA modulus size in bits. Keys below this are rejected
 * regardless of a valid signature: an attacker who controls an undersized
 * key's private half could otherwise mint accepted proofs.
 */
const MIN_RSA_KEY_BITS = 2048;

/** RSA/EC private-key JWK members; their presence means a private key was sent. */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi"] as const;

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

function fail(reason: DpopFailureReason): DpopVerifyResult {
  return { valid: false, reason };
}

function base64urlToBytes(segment: string): Uint8Array {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeJsonSegment(segment: string): unknown {
  const text = new TextDecoder().decode(base64urlToBytes(segment));
  return JSON.parse(text) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bit length of an RSA modulus encoded as a base64url big-endian integer
 * (the JWK `n` member). Leading zero bytes are ignored. Returns 0 if `n`
 * cannot be decoded or is empty.
 */
function rsaModulusBits(n: string): number {
  let bytes: Uint8Array;
  try {
    bytes = base64urlToBytes(n);
  } catch {
    return 0;
  }
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  if (i >= bytes.length) return 0;
  let bits = (bytes.length - i - 1) * 8;
  for (let v = bytes[i]!; v > 0; v >>= 1) bits++;
  return bits;
}

/**
 * Normalize an HTTP URI for `htu` comparison: lowercase the scheme and host
 * (the URL parser does this), drop default ports, and strip query and fragment.
 * Returns `null` when the URI cannot be parsed.
 *
 * No port allow-list: a non-default port present in `url.host` is kept and
 * compared exactly, but this package never restricts which ports a caller's
 * configured endpoint may use — that's deliberately out of scope (RFC 9449
 * is silent on it too), not an oversight.
 */
function normalizeHtu(uri: string): string | null {
  try {
    const url = new URL(uri);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return bytesToBase64url(new Uint8Array(digest));
}

/**
 * Compute the RFC 7638 JWK thumbprint (base64url SHA-256 over the canonical,
 * lexicographically-ordered required members). Returns `null` if the required
 * members for the key type are missing.
 */
async function jwkThumbprint(
  jwk: Record<string, unknown>,
): Promise<string | null> {
  let canonical: string;
  if (jwk.kty === "EC") {
    const { crv, x, y } = jwk;
    if (
      typeof crv !== "string" ||
      typeof x !== "string" ||
      typeof y !== "string"
    ) {
      return null;
    }
    canonical = JSON.stringify({ crv, kty: "EC", x, y });
  } else if (jwk.kty === "RSA") {
    const { e, n } = jwk;
    if (typeof e !== "string" || typeof n !== "string") {
      return null;
    }
    canonical = JSON.stringify({ e, kty: "RSA", n });
  } else {
    return null;
  }
  return sha256Base64url(canonical);
}

/** Build a clean public-only JWK for `importKey`, dropping `alg`/`use`/`key_ops`. */
function publicJwk(
  jwk: Record<string, unknown>,
  kty: "EC" | "RSA",
): JsonWebKey | null {
  if (kty === "EC") {
    const { crv, x, y } = jwk;
    if (
      typeof crv !== "string" ||
      typeof x !== "string" ||
      typeof y !== "string"
    ) {
      return null;
    }
    return { kty: "EC", crv, x, y };
  }
  const { n, e } = jwk;
  if (typeof n !== "string" || typeof e !== "string") {
    return null;
  }
  return { kty: "RSA", n, e };
}

/**
 * Verify a DPoP proof JWT and, optionally, its binding to an access token.
 *
 * Pure async function; performs no I/O beyond Web Crypto. Never throws — every
 * failure is returned as `{ valid: false, reason }` with a stable
 * {@link DpopFailureReason} code.
 *
 * @param input - Request facts, the proof, and any expected token binding.
 * @returns On success `{ valid: true, jti, jkt }`; otherwise `{ valid: false, reason }`.
 */
export async function verifyDpopProof(
  input: DpopVerifyInput,
): Promise<DpopVerifyResult> {
  const { proof, htm, htu } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;

  // 1. Parse the compact JWS: exactly three non-empty base64url segments.
  if (typeof proof !== "string") {
    return fail("proof_malformed");
  }
  const segments = proof.split(".");
  if (segments.length !== 3) {
    return fail("proof_malformed");
  }
  const [headerSeg, payloadSeg, signatureSeg] = segments as [
    string,
    string,
    string,
  ];
  if (
    !BASE64URL_SEGMENT.test(headerSeg) ||
    !BASE64URL_SEGMENT.test(payloadSeg) ||
    !BASE64URL_SEGMENT.test(signatureSeg)
  ) {
    return fail("proof_malformed");
  }

  let header: unknown;
  try {
    header = decodeJsonSegment(headerSeg);
  } catch {
    return fail("header_invalid");
  }
  if (!isObject(header)) {
    return fail("header_invalid");
  }

  // 2. Header checks: typ, crit, alg allow-list, public-only jwk.
  if (header.typ !== "dpop+jwt") {
    return fail("typ_invalid");
  }
  // RFC 7515 §4.1.11: reject any JWS carrying critical header parameters this
  // library does not understand. It understands no extensions, so any `crit`.
  if ("crit" in header) {
    return fail("crit_unsupported");
  }
  const alg = header.alg;
  const algSpec =
    typeof alg === "string" ? ALGS[alg as DpopAlgorithm] : undefined;
  if (!algSpec) {
    return fail("alg_unsupported");
  }

  const jwk = header.jwk;
  if (!isObject(jwk)) {
    return fail("jwk_missing");
  }
  if (PRIVATE_JWK_MEMBERS.some((member) => member in jwk)) {
    return fail("jwk_private");
  }
  if (jwk.kty !== algSpec.kty) {
    return fail("jwk_invalid");
  }
  // EC: the curve must be the one the alg implies (ES256⇒P-256, …). WebCrypto
  // would also reject a mismatch on import, but check it explicitly up front.
  // A missing/non-string `crv` is malformed, not a mismatch — let it fall
  // through to `publicJwk` below, which rejects it as `jwk_invalid`.
  if (
    algSpec.kty === "EC" &&
    typeof jwk.crv === "string" &&
    jwk.crv !== algSpec.expectedCrv
  ) {
    return fail("crv_mismatch");
  }
  // RSA: reject undersized moduli whose private half an attacker could control.
  // A missing/non-string `n` is malformed, not undersized — let it fall through
  // to `publicJwk` below, which rejects it as `jwk_invalid`.
  if (algSpec.kty === "RSA") {
    const n = jwk.n;
    if (typeof n === "string" && rsaModulusBits(n) < MIN_RSA_KEY_BITS) {
      return fail("rsa_key_too_small");
    }
  }
  const importable = publicJwk(jwk, algSpec.kty);
  if (importable === null) {
    return fail("jwk_invalid");
  }

  // 3. Verify the signature over `header.payload` using the embedded jwk.
  let signatureValid: boolean;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      importable,
      algSpec.importParams,
      false,
      ["verify"],
    );
    signatureValid = await crypto.subtle.verify(
      algSpec.verifyParams,
      key,
      base64urlToBytes(signatureSeg),
      new TextEncoder().encode(`${headerSeg}.${payloadSeg}`),
    );
  } catch {
    return fail("jwk_invalid");
  }
  if (!signatureValid) {
    return fail("signature_invalid");
  }

  let payload: unknown;
  try {
    payload = decodeJsonSegment(payloadSeg);
  } catch {
    return fail("payload_invalid");
  }
  if (!isObject(payload)) {
    return fail("payload_invalid");
  }

  // 4. Claim checks: htm, htu, iat window, jti.
  if (
    typeof payload.htm !== "string" ||
    payload.htm.toUpperCase() !== htm.toUpperCase()
  ) {
    return fail("htm_mismatch");
  }

  const expectedHtu = normalizeHtu(htu);
  if (expectedHtu === null) {
    return fail("htu_invalid");
  }
  const proofHtu =
    typeof payload.htu === "string" ? normalizeHtu(payload.htu) : null;
  if (proofHtu === null || proofHtu !== expectedHtu) {
    return fail("htu_mismatch");
  }

  const iat = payload.iat;
  if (typeof iat !== "number" || !Number.isFinite(iat)) {
    return fail("iat_invalid");
  }
  if (iat < now - maxAgeSeconds) {
    return fail("proof_expired");
  }
  if (iat > now + maxAgeSeconds) {
    return fail("proof_future");
  }

  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    return fail("jti_missing");
  }
  const jti = payload.jti;

  // Server-provided nonce (RFC 9449 §4.3 step 10): when the caller issued a
  // nonce, the proof's `nonce` claim MUST equal it. Surface the proof's nonce
  // either way so the caller can answer a mismatch with `use_dpop_nonce`.
  const nonce = typeof payload.nonce === "string" ? payload.nonce : undefined;
  if (input.expectedNonce !== undefined && nonce !== input.expectedNonce) {
    return { valid: false, reason: "nonce_mismatch", nonce };
  }

  // Compute the thumbprint once, for both the cnf.jkt check and the result.
  const jkt = await jwkThumbprint(jwk);
  if (jkt === null) {
    return fail("jwk_invalid");
  }

  // 5. Resource Server: access-token hash binding. Enforcing `ath` without the
  //    `cnf.jkt` binding would let a proof made for the token but signed by any
  //    key validate, defeating proof-of-possession (RFC 9449 §7.1), so an
  //    access token requires the expected thumbprint too.
  if (input.accessToken !== undefined) {
    if (input.expectedJkt === undefined) {
      return fail("jkt_required");
    }
    const expectedAth = await sha256Base64url(input.accessToken);
    if (typeof payload.ath !== "string" || payload.ath !== expectedAth) {
      return fail("ath_mismatch");
    }
  }

  // 6. Resource Server: token confirmation thumbprint binding.
  if (input.expectedJkt !== undefined && input.expectedJkt !== jkt) {
    return fail("jkt_mismatch");
  }

  // 7. Success.
  return { valid: true, jti, jkt, nonce };
}
