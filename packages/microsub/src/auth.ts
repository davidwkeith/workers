/**
 * Request authorization: validate the IndieAuth access token, complete its DPoP
 * proof-of-possession binding, honour revocation, and gate the action on the
 * token's scope.
 *
 * Mirrors `@dwk/micropub`'s authorization exactly — Microsub is the read side of
 * the same identity layer, so it accepts the same DPoP-bound HS256 access tokens
 * `@dwk/indieauth` mints and applies the same single-owner subject check: a
 * token minted by this issuer for a *different* `me` cannot read here. The DPoP
 * proof binds the token to this exact request (RFC 9449), so a stolen bearer
 * token alone is useless; revocation is checked against the strongly-consistent
 * issued-token store, never a cache. Replay detection (for state-changing
 * `POST`s) is the caller's, recorded in the strongly-consistent `MICROSUB_DB`.
 *
 * @packageDocumentation
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
import type { MicrosubStoreEnv } from "./store.js";

/** Bindings the authorization path needs. */
export interface AuthEnv extends IndieAuthStoreEnv, MicrosubStoreEnv {
  /** HMAC key the IndieAuth token endpoint signed access tokens with. */
  readonly TOKEN_SIGNING_KEY: string;
}

/** A failed authorization: an OAuth-style error to surface to the client. */
export interface AuthFailure {
  readonly ok: false;
  readonly error: string;
  readonly description: string;
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
 * against this request (`htm`/`htu`/`ath`/`cnf.jkt`), checks revocation, records
 * the proof for replay detection (when `recordReplay`), and — when
 * `requiredScopes` is non-empty — enforces scope.
 *
 * `expectedHtu` is the configured, public endpoint URL the DPoP proof's `htu`
 * must match — NOT `request.url`, which diverges from what the client signed
 * when the package is mounted behind a path-rewriting proxy.
 */
export async function authorize(
  request: Request,
  env: AuthEnv,
  config: ResolvedConfig,
  token: string | null,
  requiredScopes: readonly string[],
  recordReplay: boolean,
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
  // Microsub endpoint serves a single user, so reject any token whose subject is
  // not this user — otherwise any token from the same issuer (for any `me`)
  // could read this timeline. Both sides are canonicalized, so this is exact.
  if (claims.sub !== config.me) {
    return failure(
      "invalid_token",
      "access token subject is not the owner of this server",
      403,
    );
  }

  // Complete the DPoP proof-of-possession binding for this request.
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

  // Replay: only for state-changing requests. A captured GET proof is far less
  // valuable, and recording every read's proof would write on the read path.
  if (recordReplay && config.checkDpopReplay && dpop.jti) {
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
