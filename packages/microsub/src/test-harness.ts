/**
 * Test-only helpers: real ES256 DPoP proofs and HS256 access tokens minted with
 * the same `@dwk/indieauth` primitives the handler verifies (no mocking), plus
 * the request-header builders the handler tests share. Excluded from the
 * published build and from coverage. Not part of the package's public surface.
 */

import {
  createIndieAuthStore,
  signAccessToken,
  type IndieAuthStoreEnv,
} from "@dwk/indieauth";

import type { AuthEnv } from "./auth.js";

export const BASE = "https://example.com";
export const ME = "https://alice.example.com/";
export const CLIENT_ID = "https://app.example.org/";
export const MICROSUB = `${BASE}/microsub`;

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return bytesToBase64url(new Uint8Array(digest));
}

export interface DpopKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  jkt: string;
}

export async function makeDpopKey(): Promise<DpopKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;
  delete publicJwk.d;
  const canonical = JSON.stringify({
    crv: publicJwk.crv,
    kty: "EC",
    x: publicJwk.x,
    y: publicJwk.y,
  });
  const jkt = await sha256Base64url(canonical);
  return { privateKey: pair.privateKey, publicJwk, jkt };
}

export async function makeProof(
  key: DpopKey,
  htm: string,
  htu: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk };
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
    ...extra,
  };
  const headerSeg = bytesToBase64url(
    new TextEncoder().encode(JSON.stringify(header)),
  );
  const payloadSeg = bytesToBase64url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${bytesToBase64url(signature)}`;
}

export interface MintedToken {
  token: string;
  key: DpopKey;
}

/** Mint a DPoP-bound access token and record it in the issued-token store. */
export async function mintToken(
  env: AuthEnv,
  scope: string,
  me: string = ME,
): Promise<MintedToken> {
  const key = await makeDpopKey();
  const now = Math.floor(Date.now() / 1000);
  const minted = await signAccessToken(env.TOKEN_SIGNING_KEY, {
    issuer: BASE,
    me,
    clientId: CLIENT_ID,
    scope,
    jkt: key.jkt,
    lifetimeSeconds: 3600,
    now,
  });
  await createIndieAuthStore(env as IndieAuthStoreEnv).recordToken({
    jti: minted.claims.jti,
    clientId: CLIENT_ID,
    me,
    scope,
    jkt: key.jkt,
    issuedAt: minted.claims.iat,
    expiresAt: minted.claims.exp,
  });
  return { token: minted.token, key };
}

/** Build the `Authorization` + `DPoP` headers for a token-bound request. */
export async function authHeaders(
  minted: MintedToken,
  htm: string,
  htu: string,
): Promise<Record<string, string>> {
  return {
    Authorization: `DPoP ${minted.token}`,
    DPoP: await makeProof(minted.key, htm, htu, {
      ath: await sha256Base64url(minted.token),
    }),
  };
}
