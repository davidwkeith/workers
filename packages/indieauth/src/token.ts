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
  const bytes = new Uint8Array(sig);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
  const claims: AccessTokenClaims = {
    iss: input.issuer,
    sub: input.me,
    client_id: input.clientId,
    scope: input.scope,
    cnf: { jkt: input.jkt },
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
  const { iss, sub, client_id, scope, cnf, iat, exp, jti } = payload;
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

  if (iss !== options.issuer) return fail("issuer_mismatch");
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
      iat,
      exp,
      jti,
    },
  };
}

/** Compute the `base64url(SHA-256(token))` access-token hash (DPoP `ath`). */
export function accessTokenHash(token: string): Promise<string> {
  return sha256Base64url(token);
}
