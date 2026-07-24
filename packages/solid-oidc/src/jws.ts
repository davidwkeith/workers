/**
 * ES256 (ECDSA P-256 + SHA-256) compact JWS signing, plus the public-JWK
 * derivation the JWKS endpoint publishes. Solid pods verify an OP's access
 * tokens asymmetrically against the OP's JWKS (`@dwk/solid-pod`'s `jwt.ts`
 * accepts `ES256`/`ES384`/`RS256`/`PS256` — never `HS*`), so the OP MUST sign
 * with a private key whose public half it hosts. WebCrypto's ECDSA signature
 * is already the raw `r‖s` pair JOSE wants, so no DER re-encoding is needed.
 *
 * @packageDocumentation
 */

import { bytesToBase64url, textToBase64url } from "./encoding.js";

/**
 * A JWK carrying the JOSE metadata member (`kid`) that
 * `@cloudflare/workers-types`' `JsonWebKey` omits. Used for the OP's signing
 * key and the published public key.
 */
export type Jwk = JsonWebKey & { kid?: string };

/** The one JWS algorithm this OP issues with. */
export const SIGNING_ALG = "ES256" as const;

/** WebCrypto import params for a P-256 signing/verification key. */
const EC_IMPORT = { name: "ECDSA", namedCurve: "P-256" } as const;
const EC_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/**
 * An imported OP signing key: the private `CryptoKey` used to sign, the public
 * JWK published at JWKS (with `kid`/`use`/`alg`), and the `kid` stamped into
 * every token header so a pod can select the right key.
 */
export interface SigningKey {
  readonly privateKey: CryptoKey;
  readonly publicJwk: Jwk;
  readonly kid: string;
}

/**
 * Import an ES256 private key from its JWK (the composer-injected secret) and
 * derive the public JWK for JWKS. The `kid` is taken from the JWK when present,
 * else computed as the RFC 7638 thumbprint so it is stable and key-derived.
 * Throws when the JWK is not a usable P-256 private key.
 */
export async function importSigningKey(jwk: Jwk): Promise<SigningKey> {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
    throw new Error("solid-oidc: signing key must be an EC P-256 JWK");
  }
  if (typeof jwk.d !== "string") {
    throw new Error("solid-oidc: signing key JWK is missing the private 'd'");
  }
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("solid-oidc: signing key JWK is missing 'x'/'y'");
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    // Drop any alg/use/key_ops that could conflict with the import params.
    { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y },
    EC_IMPORT,
    false,
    ["sign"],
  );
  const kid =
    typeof jwk.kid === "string" && jwk.kid.length > 0
      ? jwk.kid
      : await ecThumbprint(jwk.crv, jwk.x, jwk.y);
  const publicJwk: Jwk = {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    use: "sig",
    alg: SIGNING_ALG,
    kid,
  };
  return { privateKey, publicJwk, kid };
}

/**
 * Sign a compact JWS over `{header, payload}` with the P-256 private key.
 * `header.alg` is forced to `ES256` and `kid` is set from the key, so callers
 * pass only `typ` and the claim set.
 */
export async function signJws(
  key: SigningKey,
  header: Readonly<Record<string, unknown>>,
  payload: Readonly<Record<string, unknown>>,
): Promise<string> {
  const fullHeader = { ...header, alg: SIGNING_ALG, kid: key.kid };
  const signingInput = `${textToBase64url(
    JSON.stringify(fullHeader),
  )}.${textToBase64url(JSON.stringify(payload))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      EC_SIGN,
      key.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${bytesToBase64url(signature)}`;
}

/**
 * RFC 7638 JWK thumbprint for an EC key (base64url SHA-256 over the canonical,
 * lexicographically-ordered required members `{crv,kty,x,y}`).
 */
async function ecThumbprint(
  crv: string,
  x: string,
  y: string,
): Promise<string> {
  const canonical = JSON.stringify({ crv, kty: "EC", x, y });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return bytesToBase64url(new Uint8Array(digest));
}

/**
 * Generate a fresh ES256 signing key as an exportable private JWK — a
 * convenience for a composer provisioning its first key (or tests). Production
 * deployments persist this JWK as an injected secret.
 */
export async function generateSigningJwk(): Promise<Jwk> {
  const pair = (await crypto.subtle.generateKey(EC_IMPORT, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // `exportKey("jwk", …)` is typed as `ArrayBuffer | JsonWebKey` across all
  // formats; the `"jwk"` format always yields a JsonWebKey.
  return (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Jwk;
}
