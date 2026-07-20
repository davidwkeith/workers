/**
 * Request authorization: validate the IndieAuth access token, complete its DPoP
 * proof-of-possession binding, honour revocation, and gate the action on the
 * token's scope.
 *
 * The token is an HS256 JWT minted by `@dwk/indieauth`; verification reuses that
 * package's `verifyAccessToken` (signature + `iss` + time window). The token is
 * **DPoP-bound** (RFC 9449): the request MUST carry a `DPoP` proof whose key
 * thumbprint matches the token's `cnf.jkt` and whose `ath` matches the token, so
 * a stolen bearer token alone is useless. Revocation is checked against the
 * strongly-consistent issued-token store — never a cache.
 */

import { DEFAULT_MAX_AGE_SECONDS, verifyDpopProof } from "@dwk/dpop";
import {
  createIndieAuthStore,
  verifyAccessToken,
  type AccessTokenClaims,
  type IndieAuthStoreEnv,
} from "@dwk/indieauth";

import type { ResolvedConfig } from "./config.js";
import { createDpopReplayStore } from "./replay.js";
import type { MicropubStoreEnv } from "./store.js";

/** Bindings the authorization path needs. */
export interface AuthEnv extends IndieAuthStoreEnv, MicropubStoreEnv {
  /** HMAC key the IndieAuth token endpoint signed access tokens with. */
  readonly TOKEN_SIGNING_KEY: string;
}

/** A failed authorization: an OAuth-style error to surface to the client. */
export interface AuthFailure {
  readonly ok: false;
  /** OAuth/Micropub error code (`invalid_request`, `invalid_token`, …). */
  readonly error: string;
  readonly description: string;
  /** HTTP status to respond with (401, 403, …). */
  readonly status: number;
}

/** A successful authorization: the verified token claims. */
export interface AuthSuccess {
  readonly ok: true;
  readonly claims: AccessTokenClaims;
}

export type AuthResult = AuthSuccess | AuthFailure;

function failure(
  error: string,
  description: string,
  status: number,
): AuthFailure {
  return { ok: false, error, description, status };
}

/**
 * Extract the bearer token from the `Authorization` header. Both the RFC 9449
 * `DPoP` scheme (which our tokens use) and the legacy `Bearer` scheme are
 * accepted. Returns `null` when the header is absent or malformed.
 */
export function tokenFromHeader(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^(DPoP|Bearer)\s+(.+)$/i.exec(header.trim());
  return match ? (match[2] as string) : null;
}

/** Whether the granted scope string contains any of the acceptable scopes. */
export function hasScope(
  scope: string,
  acceptable: readonly string[],
): boolean {
  const granted = scope.split(/\s+/).filter(Boolean);
  return acceptable.some((s) => granted.includes(s));
}

/**
 * Authorize a request. Verifies the access token, completes the DPoP binding
 * against this request (`htm`/`htu`/`ath`/`cnf.jkt`), checks revocation, and —
 * when `requiredScopes` is non-empty — enforces scope.
 *
 * `expectedHtu` is the configured, public endpoint URL the DPoP proof's `htu`
 * must match — NOT `request.url`, which diverges from what the client signed
 * when the package is mounted behind a path-rewriting proxy (the mountable-
 * prefix deployment this repo targets). The caller passes the endpoint the
 * request semantically hit (Micropub vs. media).
 */
export async function authorize(
  request: Request,
  env: AuthEnv,
  config: ResolvedConfig,
  token: string | null,
  requiredScopes: readonly string[],
  expectedHtu: string,
): Promise<AuthResult> {
  if (!token) {
    return failure("unauthorized", "a bearer access token is required", 401);
  }

  const verified = await verifyAccessToken(token, env.TOKEN_SIGNING_KEY, {
    issuer: config.tokenIssuer,
  });
  if (!verified.valid) {
    return failure(
      "invalid_token",
      `access token rejected: ${verified.reason}`,
      401,
    );
  }
  const claims = verified.claims;

  // The token's subject (`sub`) is the canonical `me` it was minted for. A
  // Micropub endpoint serves a single site, so reject any token whose subject is
  // not this site's owner — otherwise any token from the same issuer (for any
  // `me`) carrying the right scope could publish here. `config.me` and `sub` are
  // both canonicalized (at resolve and at mint), so this is an exact compare.
  if (claims.sub !== config.me) {
    return failure(
      "invalid_token",
      "access token subject is not the owner of this site",
      403,
    );
  }

  // Complete the DPoP proof-of-possession binding for this request. DPoP is
  // mandatory here even though Micropub §5.2 would allow a plain Bearer token:
  // this is the deliberate "DPoP everywhere" posture (see
  // spec/packages/micropub.md "Auth / security" and
  // spec/non-functional-requirements.md), so a token with no matching proof is
  // always rejected.
  const proof = request.headers.get("DPoP");
  if (!proof) {
    return failure(
      "invalid_request",
      "a DPoP proof is required for token-bound requests",
      401,
    );
  }
  const dpop = await verifyDpopProof({
    proof,
    htm: request.method,
    htu: expectedHtu,
    accessToken: token,
    expectedJkt: claims.cnf.jkt,
  });
  if (!dpop.valid) {
    return failure(
      "invalid_token",
      `DPoP proof verification failed: ${dpop.reason}`,
      401,
    );
  }

  // Replay: `@dwk/dpop` proves a single proof is fresh but, per RFC 9449,
  // delegates replay detection to the caller. Record the accepted `jti` in the
  // strongly-consistent store and reject a duplicate, so a captured proof can't
  // be replayed within its acceptance window to repeat this request. The TTL
  // spans `2 × DEFAULT_MAX_AGE_SECONDS` because a proof's `iat` may sit anywhere
  // in `±DEFAULT_MAX_AGE_SECONDS`, so it stays acceptable across that full span.
  if (config.checkDpopReplay && dpop.jti) {
    const now = Math.floor(Date.now() / 1000);
    const fresh = await createDpopReplayStore(env).recordProof(
      dpop.jti,
      now + 2 * DEFAULT_MAX_AGE_SECONDS,
      now,
    );
    if (!fresh) {
      return failure(
        "invalid_token",
        "DPoP proof has already been used (replay detected)",
        401,
      );
    }
  }

  // Revocation: staleness here is a security bug, so hit the strongly-consistent
  // issued-token store rather than any cache.
  if (config.checkRevocation) {
    const store = createIndieAuthStore(env);
    const now = Math.floor(Date.now() / 1000);
    if (!(await store.isTokenActive(claims.jti, now))) {
      return failure("invalid_token", "access token has been revoked", 401);
    }
  }

  if (requiredScopes.length > 0 && !hasScope(claims.scope, requiredScopes)) {
    return failure(
      "insufficient_scope",
      `this action requires one of the scopes: ${requiredScopes.join(", ")}`,
      403,
    );
  }

  return { ok: true, claims };
}
