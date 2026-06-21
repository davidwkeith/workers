/**
 * Edge authentication for the vault: resolve an OAuth 2.0 bearer token into the
 * scopes it grants, before any request reaches the per-account Durable Object.
 *
 * remoteStorage uses **plain bearer tokens** (no DPoP). A request with no
 * `Authorization` header is `anonymous` — only `/public/` document reads will
 * then succeed. A request that *presents* a token must verify fully or it is
 * `rejected`: the built-in verifier checks the issuer JWKS signature and the
 * `iss` / `aud` / `exp` / `nbf` claims, then reads the OAuth `scope` claim. A
 * deployer-supplied {@link RemoteStorageConfig.authenticate} hook fully replaces
 * the built-in path (e.g. to introspect opaque tokens via RFC 7662).
 */

import type { ResolvedConfig } from "./config.js";
import { decodeJwt, verifyJwtSignature } from "./jwt.js";
import { parseScopes, type RemoteStorageScope } from "./scope.js";

/** The verified facts a token yields: its scopes and (optionally) its subject. */
export interface RemoteStorageAuth {
  /** The remoteStorage scopes the token grants. */
  readonly scopes: readonly RemoteStorageScope[];
  /** The token subject (`sub`), used only for sanitized logging. */
  readonly subject?: string;
}

/** A stable reason a token failed verification (for `WWW-Authenticate`). */
export type AuthFailureReason =
  | "no_jwks"
  | "token_malformed"
  | "signature_invalid"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "token_expired"
  | "token_not_yet_valid";

/** Outcome of {@link authenticate}: scopes, an explicit failure, or "no creds". */
export type AuthResult =
  | { readonly kind: "authenticated"; readonly auth: RemoteStorageAuth }
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
    const body = (await response.json()) as { keys?: JsonWebKey[] } | null;
    // Only cache a well-formed JWKS; a null/empty/garbled body (e.g. literal
    // JSON `null`) is ignored rather than throwing — and caching it would poison
    // verification for the whole TTL and discard the last good keys.
    if (!body || !Array.isArray(body.keys)) return cached?.keys ?? null;
    jwksCache.set(config.jwksUri, { keys: body.keys, fetchedAt: now });
    return body.keys;
  } catch {
    return cached?.keys ?? null;
  }
}

/** Extract the `Bearer <token>` value, if present. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}

/** Whether the token's `aud` claim intersects the accepted audience set. */
function audienceMatches(aud: unknown, accepted: readonly string[]): boolean {
  if (accepted.length === 0) return true; // audience check disabled
  const values = Array.isArray(aud)
    ? aud.filter((a): a is string => typeof a === "string")
    : typeof aud === "string"
      ? [aud]
      : [];
  return values.some((a) => accepted.includes(a));
}

/**
 * Authenticate a request at the edge. Returns `anonymous` when no credentials
 * are presented, `authenticated` with the granted scopes on success, and
 * `rejected` with a stable reason on any failure of a *presented* token.
 */
export async function authenticate(
  request: Request,
  config: ResolvedConfig,
): Promise<AuthResult> {
  // A deployer-supplied hook fully replaces the built-in verifier.
  if (config.authenticate) {
    const auth = await config.authenticate(request);
    return auth ? { kind: "authenticated", auth } : { kind: "anonymous" };
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

  const { iss, aud, exp, nbf, sub, scope } = decoded.payload;
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
  if (nbf !== undefined && (typeof nbf !== "number" || now < nbf)) {
    return { kind: "rejected", reason: "token_not_yet_valid" };
  }

  return {
    kind: "authenticated",
    auth: {
      scopes: parseScopes(typeof scope === "string" ? scope : undefined),
      ...(typeof sub === "string" ? { subject: sub } : {}),
    },
  };
}
