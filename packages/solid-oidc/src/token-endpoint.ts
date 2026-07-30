/**
 * `POST /token` — the token endpoint. Exchanges a PKCE-bound authorization code
 * for a **DPoP-bound** ES256 access token (with a `webid` claim the pod reads)
 * plus an OIDC ID token. RFC 9449 requires a DPoP proof at the token endpoint;
 * its key thumbprint is bound into the access token as `cnf.jkt`.
 *
 * @packageDocumentation
 */

import { verifyDpopProof } from "@dwk/dpop";

import { readRequestBodyCapped } from "./body.js";
import type { ResolvedSolidOidcConfig } from "./config.js";
import { oauthError, json } from "./http.js";
import { importSigningKey } from "./jws.js";
import { verifyPkce } from "./pkce.js";
import type { CodeStore } from "./store.js";
import { mintAccessToken, mintIdToken } from "./token.js";

/**
 * Cap on the token endpoint's form body (8 KiB). This endpoint is public and
 * unauthenticated prior to code/PKCE/DPoP validation, and its form fields
 * (grant type, code, redirect URI, client ID, PKCE verifier) are all short
 * opaque tokens, so a generous cap still refuses to buffer an unbounded body.
 */
const MAX_TOKEN_BODY_BYTES = 8 * 1024;

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const bytes = await readRequestBodyCapped(request, MAX_TOKEN_BODY_BYTES);
  if (bytes === null) return null;
  try {
    return new URLSearchParams(new TextDecoder().decode(bytes));
  } catch {
    // Malformed body → empty params; validation reports the error below.
    return new URLSearchParams();
  }
}

export async function handleToken(
  request: Request,
  config: ResolvedSolidOidcConfig,
  codes: CodeStore,
): Promise<Response> {
  const form = await readForm(request);
  if (form === null) {
    return oauthError(
      400,
      "invalid_request",
      "request body exceeds the maximum allowed size",
    );
  }

  if (form.get("grant_type") !== "authorization_code") {
    return oauthError(400, "unsupported_grant_type");
  }
  const code = form.get("code");
  const redirectUri = form.get("redirect_uri");
  const clientId = form.get("client_id");
  const codeVerifier = form.get("code_verifier");
  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return oauthError(
      400,
      "invalid_request",
      "code, redirect_uri, client_id, and code_verifier are required",
    );
  }

  // RFC 9449 §5: a DPoP proof for this request must accompany the token
  // request; its confirmed thumbprint is what we bind into the token.
  const proof = request.headers.get("DPoP");
  if (!proof) {
    return oauthError(
      400,
      "invalid_dpop_proof",
      "a DPoP proof is required at the token endpoint",
    );
  }
  const dpop = await verifyDpopProof({
    proof,
    htm: "POST",
    htu: config.endpoints.token,
    now: Math.floor(config.now() / 1000),
  });
  if (!dpop.valid || !dpop.jkt) {
    return oauthError(
      400,
      "invalid_dpop_proof",
      `DPoP proof rejected (${dpop.reason ?? "invalid"})`,
    );
  }

  // Redeem the code atomically (single-use). Unknown/used/expired ⇒ invalid.
  const record = await codes.redeem(code, Math.floor(config.now() / 1000));
  if (!record) {
    return oauthError(
      400,
      "invalid_grant",
      "code is invalid, used, or expired",
    );
  }
  // The code is bound to the client + redirect it was issued to.
  if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
    return oauthError(
      400,
      "invalid_grant",
      "client_id / redirect_uri does not match the code",
    );
  }
  // PKCE: prove possession of the verifier for the stored challenge.
  if (!(await verifyPkce(codeVerifier, record.codeChallenge))) {
    return oauthError(400, "invalid_grant", "PKCE verification failed");
  }

  const key = await importSigningKey(config.signingKey);
  const nowSeconds = Math.floor(config.now() / 1000);
  const access = await mintAccessToken(key, {
    issuer: config.issuer,
    webid: record.webid,
    clientId: record.clientId,
    scope: record.scope,
    jkt: dpop.jkt,
    audience: config.audience,
    lifetimeSeconds: config.accessTokenLifetimeSeconds,
    now: nowSeconds,
  });
  const idToken = await mintIdToken(key, {
    issuer: config.issuer,
    webid: record.webid,
    clientId: record.clientId,
    lifetimeSeconds: config.idTokenLifetimeSeconds,
    now: nowSeconds,
    ...(record.nonce ? { nonce: record.nonce } : {}),
  });

  return json(200, {
    access_token: access.token,
    // RFC 9449: a DPoP-bound token is returned with token_type "DPoP".
    token_type: "DPoP",
    expires_in: config.accessTokenLifetimeSeconds,
    scope: record.scope,
    id_token: idToken,
  });
}
