/**
 * The MCP auth bridge: builds the `authenticate(request)` hook `createMcp`
 * accepts, wired to bearer + DPoP-bound access tokens (spec/packages/mcp.md
 * "Auth bridge"). This package stays protocol-agnostic — it does not know how
 * to verify a bearer token itself (that is `@dwk/indieauth`'s signed JWT, or a
 * remote RFC 7662 introspection call, at the composing package's choice), so
 * token lookup is a caller-supplied {@link TokenIntrospector}. DPoP
 * proof-of-possession binding is completed via `@dwk/dpop` — a cross-standard
 * lib, so depending on it here does not leak cohort-standard knowledge into
 * this package.
 *
 * Replay tracking is likewise delegated to a caller-supplied
 * {@link DpopReplayStore}: it MUST be strongly-consistent (DO SQLite / D1) —
 * never KV (spec/non-functional-requirements.md) — and Cloudflare storage
 * specifics are confined to `@dwk/store` and the endpoint packages, not this
 * lib (spec/composition-contract.md "Confinement").
 */

import { DEFAULT_MAX_AGE_SECONDS, verifyDpopProof } from "@dwk/dpop";

import type { McpAuthContext } from "./types.js";

/**
 * The result of looking up a bearer token — e.g. via RFC 7662 introspection,
 * or a local signed-JWT verify (`@dwk/indieauth`'s `verifyAccessToken`).
 * `cnf.jkt` is required: this bridge never accepts a token that is not
 * DPoP-bound (spec/non-functional-requirements.md "DPoP everywhere").
 */
export interface IntrospectedToken {
  readonly active: boolean;
  readonly scope?: string;
  readonly sub?: string;
  readonly cnf?: { readonly jkt: string };
}

/** Look up a bearer token, returning `null` when it is unknown. */
export type TokenIntrospector = (
  token: string,
) => Promise<IntrospectedToken | null>;

/**
 * A strongly-consistent record of accepted DPoP proof `jti`s, so a captured
 * proof cannot be replayed within its acceptance window. See
 * `@dwk/micropub`'s `replay.ts` for a D1-backed example of this shape.
 */
export interface DpopReplayStore {
  /**
   * Atomically record an accepted proof `jti`. Returns `true` when the `jti`
   * was unseen (and is now recorded), `false` when it was already present —
   * a replay. `expiresAt`/`now` are seconds since the epoch.
   */
  recordProof(jti: string, expiresAt: number, now: number): Promise<boolean>;
}

export interface McpAuthBridgeConfig {
  /** Resolve a bearer token to its active-state, scope, subject, and DPoP binding. */
  readonly introspectToken: TokenIntrospector;
  /** Strongly-consistent DPoP `jti` replay store — required, never optional (never KV). */
  readonly replayStore: DpopReplayStore;
  /** Current time (seconds since the epoch). Defaults to `Date.now()`. */
  readonly now?: () => number;
  /** Allowed clock skew for the DPoP proof `iat` window. Defaults to `@dwk/dpop`'s `DEFAULT_MAX_AGE_SECONDS`. */
  readonly maxAgeSeconds?: number;
}

/**
 * Thrown by the built authenticator on any auth failure (missing/invalid
 * token, missing/invalid DPoP proof, replay). `createMcp` maps a thrown
 * `authenticate` into a `401`.
 */
export class McpAuthError extends Error {}

const TOKEN_HEADER = /^(DPoP|Bearer)\s+(.+)$/i;

/**
 * Extract the bearer token from the `Authorization` header. Both the RFC 9449
 * `DPoP` scheme (which DPoP-bound tokens use) and the legacy `Bearer` scheme
 * are accepted. Returns `null` when the header is absent or malformed.
 */
export function tokenFromAuthHeader(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = TOKEN_HEADER.exec(header.trim());
  return match ? (match[2] as string) : null;
}

/**
 * Build the `authenticate(request)` hook for `createMcp`: bearer token
 * lookup → DPoP proof-of-possession binding → replay check → granted scopes.
 * Every `tools/call` is then checked by the registry against the returned
 * scopes ∩ the tool's `requiredScope` — this function establishes identity
 * and scope, never per-tool authorization.
 */
export function createDpopBearerAuthenticator(
  config: McpAuthBridgeConfig,
): (request: Request) => Promise<McpAuthContext> {
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const maxAgeSeconds = config.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;

  return async function authenticate(
    request: Request,
  ): Promise<McpAuthContext> {
    const token = tokenFromAuthHeader(request);
    if (!token) {
      throw new McpAuthError("a bearer access token is required");
    }

    const record = await config.introspectToken(token);
    if (!record || !record.active) {
      throw new McpAuthError("access token rejected");
    }
    if (!record.cnf?.jkt) {
      throw new McpAuthError(
        "access token is not DPoP-bound (missing cnf.jkt)",
      );
    }

    const proof = request.headers.get("DPoP");
    if (!proof) {
      throw new McpAuthError(
        "a DPoP proof is required for token-bound requests",
      );
    }

    const currentTime = now();
    const dpop = await verifyDpopProof({
      proof,
      htm: request.method,
      htu: request.url,
      accessToken: token,
      expectedJkt: record.cnf.jkt,
      now: currentTime,
      maxAgeSeconds,
    });
    if (!dpop.valid || !dpop.jti) {
      throw new McpAuthError(
        `DPoP proof verification failed: ${dpop.reason ?? "jti_missing"}`,
      );
    }

    // The acceptance window spans `iat ± maxAgeSeconds`, so a `jti` must stay
    // rejected across that full span, not just until `now`.
    const fresh = await config.replayStore.recordProof(
      dpop.jti,
      currentTime + 2 * maxAgeSeconds,
      currentTime,
    );
    if (!fresh) {
      throw new McpAuthError(
        "DPoP proof has already been used (replay detected)",
      );
    }

    return {
      scopes: record.scope ? record.scope.split(/\s+/).filter(Boolean) : [],
      subject: record.sub,
    };
  };
}
