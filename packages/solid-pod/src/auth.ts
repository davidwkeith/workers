/**
 * Edge authentication for the Resource Server: validate a DPoP-bound bearer
 * token and its proof at the Worker front door, before any request reaches the
 * per-pod Durable Object.
 *
 * A request with no credentials is allowed through unauthenticated — WAC then
 * decides whether the resource is public. A request that *presents* credentials
 * must pass fully or it is rejected `401`: the token signature (issuer JWKS),
 * the `iss` / `aud` / `exp` / `webid` claims, and the RFC 9449 DPoP proof
 * binding (`htu` / `htm` / `ath` / `cnf.jkt`) via `@dwk/dpop`.
 */

import { verifyDpopProof } from "@dwk/dpop";

import type { AuthContext, ResolvedConfig } from "./config";
import { decodeJwt, verifyJwtSignature } from "./jwt";

/** A stable reason an authentication attempt failed (for `WWW-Authenticate`). */
export type AuthFailureReason =
  | "no_jwks"
  | "token_malformed"
  | "token_type_invalid"
  | "signature_invalid"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "token_expired"
  | "token_not_yet_valid"
  | "webid_missing"
  | "cnf_missing"
  | "dpop_missing"
  | "dpop_invalid";

/** Outcome of {@link authenticate}: a context, an explicit failure, or "no creds". */
export type AuthResult =
  | { readonly kind: "authenticated"; readonly context: AuthContext }
  | { readonly kind: "anonymous" }
  | { readonly kind: "rejected"; readonly reason: AuthFailureReason };

/** In-memory JWKS cache shared across requests within an isolate. */
interface CachedJwks {
  keys: readonly JsonWebKey[];
  fetchedAt: number;
}
const JWKS_TTL_MS = 5 * 60 * 1000;
const jwksCache = new Map<string, CachedJwks>();

/** Resolve the issuer verification keys: static config first, then cached fetch. */
async function resolveJwks(
  config: ResolvedConfig,
): Promise<readonly JsonWebKey[] | null> {
  if (config.jwks && config.jwks.length > 0) return config.jwks;
  if (!config.jwksUri) return null;

  const now = config.now();
  const cached = jwksCache.get(config.jwksUri);
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  try {
    const response = await config.fetch(config.jwksUri);
    if (!response.ok) return cached?.keys ?? null;
    const body = (await response.json()) as { keys?: JsonWebKey[] };
    // Only cache a well-formed JWKS; caching an empty/garbled body would poison
    // verification for the whole TTL and discard the last good keys.
    if (!Array.isArray(body.keys)) return cached?.keys ?? null;
    jwksCache.set(config.jwksUri, { keys: body.keys, fetchedAt: now });
    return body.keys;
  } catch {
    // A transient fetch failure falls back to the last good keys if we have
    // them, rather than failing closed on every request mid-outage.
    return cached?.keys ?? null;
  }
}

/** Extract the `DPoP <token>` (or `Bearer <token>`) value, if present. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^(DPoP|Bearer)\s+(.+)$/i.exec(header.trim());
  return match ? (match[2] as string) : null;
}

/**
 * Whether the token header's `typ` is the required access-token type. Compared
 * case-insensitively and tolerant of the `application/at+jwt` media-type form,
 * since RFC 9068 permits either the full media type or its `at+jwt` short form.
 */
function tokenTypeMatches(typ: unknown, required: string): boolean {
  if (typeof typ !== "string") return false;
  const normalize = (value: string): string => {
    const lower = value.toLowerCase();
    return lower.startsWith("application/")
      ? lower.slice("application/".length)
      : lower;
  };
  return normalize(typ) === normalize(required);
}

/** Whether the token's `aud` claim intersects the accepted audience set. */
function audienceMatches(aud: unknown, accepted: readonly string[]): boolean {
  const values = Array.isArray(aud)
    ? aud.filter((a): a is string => typeof a === "string")
    : typeof aud === "string"
      ? [aud]
      : [];
  return values.some((a) => accepted.includes(a));
}

/**
 * Authenticate a request at the edge.
 *
 * Returns `anonymous` when no credentials are presented, `authenticated` with
 * the verified {@link AuthContext} on success, and `rejected` with a stable
 * reason on any failure of a *presented* credential.
 */
export async function authenticate(
  request: Request,
  config: ResolvedConfig,
): Promise<AuthResult> {
  // A deployer-supplied hook fully replaces the built-in verifier.
  if (config.authenticate) {
    const context = await config.authenticate(request);
    return context ? { kind: "authenticated", context } : { kind: "anonymous" };
  }

  const token = bearerToken(request);
  if (!token) return { kind: "anonymous" };

  const decoded = decodeJwt(token);
  if (!decoded) return { kind: "rejected", reason: "token_malformed" };

  const jwks = await resolveJwks(config);
  if (!jwks || jwks.length === 0)
    return { kind: "rejected", reason: "no_jwks" };

  if (!(await verifyJwtSignature(decoded, jwks))) {
    return { kind: "rejected", reason: "signature_invalid" };
  }

  // Enforce the access-token `typ` (`at+jwt`) so an ID token or other
  // issuer-signed JWT sharing this `iss`/`aud`/`webid` cannot be replayed as an
  // access token. Skipped when the deployer opts out via `accessTokenType: null`.
  if (
    config.accessTokenType !== null &&
    !tokenTypeMatches(decoded.header.typ, config.accessTokenType)
  ) {
    return { kind: "rejected", reason: "token_type_invalid" };
  }

  const { iss, aud, exp, nbf, webid, sub, cnf } = decoded.payload;
  if (config.issuer !== undefined && iss !== config.issuer) {
    return { kind: "rejected", reason: "issuer_mismatch" };
  }
  if (!audienceMatches(aud, config.audience)) {
    return { kind: "rejected", reason: "audience_mismatch" };
  }
  const now = Math.floor(config.now() / 1000);
  if (typeof exp !== "number" || now >= exp) {
    return { kind: "rejected", reason: "token_expired" };
  }
  // Honor `nbf` when present: a token is not valid before its not-before time.
  // Per RFC 7519 §4.1.5 `nbf` MUST be a number; a present-but-malformed value is
  // rejected rather than silently bypassed (mirrors the `exp` handling above).
  if (nbf !== undefined && (typeof nbf !== "number" || now < nbf)) {
    return { kind: "rejected", reason: "token_not_yet_valid" };
  }

  // Solid-OIDC carries the agent identity in `webid`; fall back to `sub`.
  const agent =
    typeof webid === "string"
      ? webid
      : typeof sub === "string"
        ? sub
        : undefined;
  if (agent === undefined) return { kind: "rejected", reason: "webid_missing" };

  const jkt =
    typeof cnf === "object" &&
    cnf !== null &&
    typeof (cnf as Record<string, unknown>).jkt === "string"
      ? ((cnf as Record<string, unknown>).jkt as string)
      : undefined;
  if (jkt === undefined) return { kind: "rejected", reason: "cnf_missing" };

  const proof = request.headers.get("dpop");
  if (!proof) return { kind: "rejected", reason: "dpop_missing" };

  const dpop = await verifyDpopProof({
    proof,
    htm: request.method,
    htu: request.url,
    accessToken: token,
    expectedJkt: jkt,
    now,
  });
  if (!dpop.valid || !dpop.jti || !dpop.jkt) {
    return { kind: "rejected", reason: "dpop_invalid" };
  }

  return {
    kind: "authenticated",
    context: { webid: agent, jti: dpop.jti, jkt: dpop.jkt },
  };
}
