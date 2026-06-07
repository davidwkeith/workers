/**
 * Access-token minting and verification.
 *
 * Issued tokens are compact, self-describing JWTs signed with HMAC-SHA-256
 * (HS256) using the deployer's secret key material. They are **DPoP-bound**: the
 * RFC 9449 confirmation claim `cnf.jkt` carries the thumbprint of the client's
 * proof-of-possession key, and a Resource Server completes the binding by
 * verifying a DPoP proof against that thumbprint (via `@dwk/dpop`).
 *
 * Verification here covers the signature, the standard time claims, and the
 * issuer — it is shared by the Solid Pod Resource Server and Micropub. Those
 * callers pass the recovered `cnf.jkt` to `@dwk/dpop` and (optionally) check
 * revocation against the token store.
 */

import {
  base64urlToText,
  bytesToBase64url,
  sha256Base64url,
  textToBase64url,
  timingSafeEqual,
} from "./encoding";

/** JWT header for HS256-signed access tokens. */
interface AccessTokenHeader {
  readonly alg: "HS256";
  readonly typ: "at+jwt";
}

/** RFC 9449 confirmation claim binding the token to a DPoP key thumbprint. */
export interface Confirmation {
  /** RFC 7638 JWK SHA-256 thumbprint of the client's DPoP key. */
  readonly jkt: string;
}

/** Registered + IndieAuth claims carried by an issued access token. */
export interface AccessTokenClaims {
  /** Issuer identifier (the IndieAuth metadata `issuer`). */
  readonly iss: string;
  /** Subject — the user's canonical profile URL (`me`). */
  readonly sub: string;
  /** The `client_id` the token was issued to. */
  readonly client_id: string;
  /** Space-separated granted scopes. */
  readonly scope: string;
  /** DPoP confirmation (`cnf.jkt`). */
  readonly cnf: Confirmation;
  /**
   * Audience restriction (RFC 8707 resource indicators / RFC 9700 §2.3): the
   * resource server identifier(s) the token may be presented to. Present only
   * when the grant was bound to one or more resource indicators; absent on an
   * unrestricted token. A Resource Server completes the restriction by passing
   * its own identifier as the expected `audience` to {@link verifyAccessToken}.
   */
  readonly aud?: readonly string[];
  /** Issued-at (seconds since the epoch). */
  readonly iat: number;
  /** Expiry (seconds since the epoch). */
  readonly exp: number;
  /** Unique token id, used for revocation lookups. */
  readonly jti: string;
}

/** Inputs to {@link signAccessToken}, before `iat`/`exp`/`jti` are derived. */
export interface MintAccessTokenInput {
  readonly issuer: string;
  readonly me: string;
  readonly clientId: string;
  readonly scope: string;
  readonly jkt: string;
  /**
   * Resource indicators (RFC 8707) to audience-restrict the token to. When
   * non-empty the minted token carries an `aud` claim, so a token leaked to one
   * resource server cannot be replayed at another (RFC 9700 §2.3). Omit or pass
   * an empty list for an unrestricted token.
   */
  readonly audience?: readonly string[];
  /** Lifetime in seconds; `exp = iat + lifetimeSeconds`. */
  readonly lifetimeSeconds: number;
  /** Current time (seconds since the epoch). Defaults to `Date.now()`. */
  readonly now?: number;
}

/** A freshly minted token: the bearer string plus its decoded claims. */
export interface MintedAccessToken {
  readonly token: string;
  readonly claims: AccessTokenClaims;
}

/** Outcome of {@link verifyAccessToken}. */
export type VerifyAccessTokenResult =
  | { readonly valid: true; readonly claims: AccessTokenClaims }
  | { readonly valid: false; readonly reason: AccessTokenFailureReason };

/** Stable, locale-independent token-verification failure codes. */
export type AccessTokenFailureReason =
  | "malformed"
  | "header_invalid"
  | "alg_unsupported"
  | "signature_invalid"
  | "payload_invalid"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "expired"
  | "not_yet_valid";

const HEADER: AccessTokenHeader = { alg: "HS256", typ: "at+jwt" };

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacSign(signingInput: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  return bytesToBase64url(new Uint8Array(sig));
}

/**
 * Normalize requested resource indicators into the `aud` claim value: drop
 * empties, de-duplicate (order-preserving), and collapse an empty result to
 * `undefined` so no `aud` is emitted for an unrestricted token.
 */
function normalizeAudience(
  audience: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!audience || audience.length === 0) return undefined;
  const seen = new Set<string>();
  for (const value of audience) {
    if (typeof value === "string" && value !== "") seen.add(value);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/**
 * Mint a DPoP-bound access token. The returned `token` is a compact HS256 JWT;
 * `claims` is the decoded payload (so the caller can record `jti`/`exp` in the
 * token store without re-parsing).
 */
export async function signAccessToken(
  secret: string,
  input: MintAccessTokenInput,
): Promise<MintedAccessToken> {
  const iat = input.now ?? Math.floor(Date.now() / 1000);
  const aud = normalizeAudience(input.audience);
  const claims: AccessTokenClaims = {
    iss: input.issuer,
    sub: input.me,
    client_id: input.clientId,
    scope: input.scope,
    cnf: { jkt: input.jkt },
    // Only emit `aud` when the grant was audience-restricted, so unrestricted
    // tokens stay byte-for-byte as before.
    ...(aud ? { aud } : {}),
    iat,
    exp: iat + input.lifetimeSeconds,
    jti: crypto.randomUUID(),
  };
  const headerSeg = textToBase64url(JSON.stringify(HEADER));
  const payloadSeg = textToBase64url(JSON.stringify(claims));
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const signature = await hmacSign(signingInput, secret);
  return { token: `${signingInput}.${signature}`, claims };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(reason: AccessTokenFailureReason): VerifyAccessTokenResult {
  return { valid: false, reason };
}

/** Options for {@link verifyAccessToken}. */
export interface VerifyAccessTokenOptions {
  /** Expected issuer; rejected with `issuer_mismatch` if the `iss` differs. */
  readonly issuer: string;
  /**
   * Expected audience — this Resource Server's identifier. When set, the token
   * MUST carry an `aud` (RFC 8707) that includes this value, otherwise
   * verification fails with `audience_mismatch` (RFC 9700 §2.3): a token
   * audience-restricted to (or carrying no restriction for) a different resource
   * server cannot be replayed here. When omitted, the audience is not checked.
   */
  readonly audience?: string;
  /** Current time (seconds since the epoch). Defaults to `Date.now()`. */
  readonly now?: number;
}

/**
 * Verify an access token's HS256 signature, `iss`, and time window, returning
 * the decoded claims on success. Never throws — every failure is a stable
 * `{ valid: false, reason }`.
 *
 * This does **not** check the DPoP binding or revocation: the caller passes the
 * returned `cnf.jkt` to `@dwk/dpop` and, if it tracks revocation, looks up the
 * `jti` in the token store.
 */
export async function verifyAccessToken(
  token: string,
  secret: string,
  options: VerifyAccessTokenOptions,
): Promise<VerifyAccessTokenResult> {
  if (typeof token !== "string") return fail("malformed");
  const segments = token.split(".");
  if (segments.length !== 3) return fail("malformed");
  const [headerSeg, payloadSeg, signatureSeg] = segments as [
    string,
    string,
    string,
  ];

  let header: unknown;
  try {
    header = JSON.parse(base64urlToText(headerSeg));
  } catch {
    return fail("header_invalid");
  }
  if (!isObject(header) || header.typ !== "at+jwt")
    return fail("header_invalid");
  if (header.alg !== "HS256") return fail("alg_unsupported");

  const expectedSig = await hmacSign(`${headerSeg}.${payloadSeg}`, secret);
  if (!timingSafeEqual(expectedSig, signatureSeg)) {
    return fail("signature_invalid");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(base64urlToText(payloadSeg));
  } catch {
    return fail("payload_invalid");
  }
  if (!isObject(payload)) return fail("payload_invalid");
  const { iss, sub, client_id, scope, cnf, aud, iat, exp, jti } = payload;
  if (
    typeof iss !== "string" ||
    typeof sub !== "string" ||
    typeof client_id !== "string" ||
    typeof scope !== "string" ||
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    typeof jti !== "string" ||
    !isObject(cnf) ||
    typeof cnf.jkt !== "string"
  ) {
    return fail("payload_invalid");
  }
  // `aud` (RFC 7519) is a string or an array of strings; reject any other shape.
  const audience = readAudienceClaim(aud);
  if (audience === INVALID_AUDIENCE) return fail("payload_invalid");

  if (iss !== options.issuer) return fail("issuer_mismatch");
  // Audience restriction: when the RS expects an audience, the token must be
  // explicitly restricted to (or among) it. A token with no `aud` does not
  // satisfy an expected audience.
  if (
    options.audience !== undefined &&
    !(audience !== undefined && audience.includes(options.audience))
  ) {
    return fail("audience_mismatch");
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (now >= exp) return fail("expired");
  if (now < iat) return fail("not_yet_valid");

  return {
    valid: true,
    claims: {
      iss,
      sub,
      client_id,
      scope,
      cnf: { jkt: cnf.jkt },
      ...(audience ? { aud: audience } : {}),
      iat,
      exp,
      jti,
    },
  };
}

/** Sentinel returned by {@link readAudienceClaim} for a malformed `aud`. */
const INVALID_AUDIENCE = Symbol("invalid_audience");

/**
 * Interpret a decoded `aud` claim. Returns the normalized audience array (for a
 * single-string or string-array claim), `undefined` when absent, or
 * {@link INVALID_AUDIENCE} when present but malformed (empty, or containing a
 * non-string / empty member).
 */
function readAudienceClaim(
  aud: unknown,
): readonly string[] | undefined | typeof INVALID_AUDIENCE {
  if (aud === undefined) return undefined;
  if (typeof aud === "string") return aud === "" ? INVALID_AUDIENCE : [aud];
  if (Array.isArray(aud)) {
    if (aud.length === 0) return INVALID_AUDIENCE;
    if (!aud.every((value) => typeof value === "string" && value !== "")) {
      return INVALID_AUDIENCE;
    }
    return aud as readonly string[];
  }
  return INVALID_AUDIENCE;
}

/** Compute the `base64url(SHA-256(token))` access-token hash (DPoP `ath`). */
export function accessTokenHash(token: string): Promise<string> {
  return sha256Base64url(token);
}
