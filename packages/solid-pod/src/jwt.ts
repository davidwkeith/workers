/**
 * Minimal JWT decode and JWKS-based signature verification for the Resource
 * Server edge.
 *
 * Solid-OIDC access tokens are asymmetrically signed by the issuer (the OP), so
 * — unlike `@dwk/indieauth`'s HS256 self-issued tokens — verification needs the
 * issuer's public JWKS rather than a shared secret. This module decodes the
 * compact JWS, selects the key by `kid`/`kty`, and verifies the signature with
 * Web Crypto. It performs no claim policy (issuer/audience/expiry) itself; that
 * lives in `auth.ts`.
 *
 * Only asymmetric algorithms are accepted. `HS*` and `none` are refused: an
 * access token must be signed by the issuer's private key, never a symmetric
 * secret an RS could not safely hold.
 */

import { base64urlToBytes, base64urlToText } from "./encoding.js";

/** Asymmetric JOSE algorithms accepted for issuer-signed access tokens. */
export type JwtAlgorithm = "ES256" | "ES384" | "RS256" | "PS256";

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
  crv?: string;
  importParams: ImportAlg;
  verifyParams: VerifyAlg;
}

// We avoid the DOM lib's algorithm-parameter type names (not declared by
// @cloudflare/workers-types); these objects are accepted structurally by
// crypto.subtle.importKey / verify, mirroring the approach in `@dwk/dpop`.
const ALGS: Record<JwtAlgorithm, AlgSpec> = {
  ES256: {
    kty: "EC",
    crv: "P-256",
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    verifyParams: { name: "ECDSA", hash: "SHA-256" },
  },
  ES384: {
    kty: "EC",
    crv: "P-384",
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

/** A decoded JWT: its header, claims, and the raw segments for verification. */
export interface DecodedJwt {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode a compact JWS into its header, payload, and signature. Returns `null`
 * for anything that is not three base64url segments with JSON header/payload.
 */
export function decodeJwt(token: string): DecodedJwt | null {
  if (typeof token !== "string") return null;
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const [headerSeg, payloadSeg, signatureSeg] = segments as [
    string,
    string,
    string,
  ];
  try {
    const header = JSON.parse(base64urlToText(headerSeg)) as unknown;
    const payload = JSON.parse(base64urlToText(payloadSeg)) as unknown;
    if (!isObject(header) || !isObject(payload)) return null;
    return {
      header,
      payload,
      signingInput: `${headerSeg}.${payloadSeg}`,
      signature: base64urlToBytes(signatureSeg),
    };
  } catch {
    return null;
  }
}

/** Whether a JWK could verify a signature under the given algorithm. */
function keyMatchesAlg(jwk: JsonWebKey, spec: AlgSpec): boolean {
  if (jwk.kty !== spec.kty) return false;
  if (spec.crv !== undefined && jwk.crv !== spec.crv) return false;
  return true;
}

/**
 * Verify `decoded`'s signature against a JWKS. Selects the verification key by
 * `kid` when the header carries one, otherwise tries every key compatible with
 * the header `alg`. Returns `true` on the first key that verifies.
 */
export async function verifyJwtSignature(
  decoded: DecodedJwt,
  jwks: readonly JsonWebKey[],
): Promise<boolean> {
  const alg = decoded.header.alg;
  const spec = typeof alg === "string" ? ALGS[alg as JwtAlgorithm] : undefined;
  if (!spec) return false;

  const kid = decoded.header.kid;
  const compatible = jwks.filter((jwk) => keyMatchesAlg(jwk, spec));

  // When the token names a `kid`, pin verification to the key(s) carrying it.
  // A token that names a `kid` matching no JWKS key is rejected rather than
  // verified against unrelated keys: trying other keys would silently weaken
  // `kid` pinning (a token claiming an unknown key still passing). Only when
  // the header omits `kid` do we try every alg-compatible key.
  let candidates = compatible;
  if (typeof kid === "string") {
    // `kid` is not in the standard JsonWebKey type but is carried by JWKS keys.
    candidates = compatible.filter(
      (jwk) => (jwk as { kid?: unknown }).kid === kid,
    );
    if (candidates.length === 0) return false;
  }

  for (const jwk of candidates) {
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        spec.importParams,
        false,
        ["verify"],
      );
      const ok = await crypto.subtle.verify(
        spec.verifyParams,
        key,
        decoded.signature,
        new TextEncoder().encode(decoded.signingInput),
      );
      if (ok) return true;
    } catch {
      // A key that fails to import (wrong shape) simply does not match; try
      // the next candidate rather than aborting the whole verification.
    }
  }
  return false;
}
