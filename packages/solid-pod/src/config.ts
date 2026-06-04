/**
 * Configuration, the declared Cloudflare `Env` fragment, and config resolution
 * for `@dwk/solid-pod`.
 *
 * Per the composition contract, the package never reads the global environment
 * directly: all tunables (base URL, token issuer/JWKS, accepted audience,
 * offload threshold, replay/GC windows) are passed into {@link createSolidPod}
 * and {@link createSolidPodGc}, so a pod can be instantiated multiple times and
 * unit-tested in isolation. The Cloudflare bindings — the per-pod Durable
 * Object namespace and the R2 blob bucket — are the only runtime coupling, and
 * a missing one fails loudly at startup.
 */

import type { SolidPodObject } from "./pod";

/** Cloudflare bindings required by the Solid Pod handler and Durable Object. */
export interface SolidPodEnv {
  /** Durable Object namespace for the per-pod class ({@link SolidPodObject}). */
  readonly POD: DurableObjectNamespace<SolidPodObject>;
  /** R2 bucket holding blob bodies. */
  readonly BLOBS: R2Bucket;
  /**
   * Shared D1 database tracking orphaned blob keys for the out-of-band GC cron.
   * Optional: when bound, the DO opportunistically forwards its transactional
   * orphan outbox here after writes so {@link createSolidPodGc} can reclaim them
   * without ever waking a Durable Object.
   */
  readonly GC_DB?: D1Database;
}

/** Cloudflare bindings required by the out-of-band R2 garbage-collection cron. */
export interface SolidPodGcEnv {
  /** R2 bucket holding blob bodies. */
  readonly BLOBS: R2Bucket;
  /** Shared D1 database tracking orphaned blob keys (see `@dwk/store`). */
  readonly GC_DB: D1Database;
}

/**
 * A verification key set used to validate issuer-signed access tokens. Supply
 * either static {@link SolidPodConfig.jwks} (hermetic, no network) or a
 * {@link SolidPodConfig.jwksUri} the handler fetches and caches.
 */
export type Jwks = readonly JsonWebKey[];

/** Configuration passed to {@link createSolidPod}. */
export interface SolidPodConfig {
  /**
   * The pod's identity root / base URL, e.g. `https://pod.example`. Used as the
   * origin for absolute resource IRIs in WAC and content negotiation, and as
   * the default token audience. No trailing slash.
   */
  readonly baseUrl: string;

  /**
   * The pod owner's WebID(s). An owner is always granted full access
   * (`Read`/`Write`/`Append`/`Control`) regardless of ACLs, which bootstraps
   * ACL management — without it, no one could create the first `.acl`.
   */
  readonly owner?: string | readonly string[];

  /**
   * Accepted access-token issuer (`iss`). When set, a token whose `iss` differs
   * is rejected. Required unless a custom {@link SolidPodConfig.authenticate}
   * hook is supplied.
   */
  readonly issuer?: string;

  /**
   * Accepted token audience(s) (`aud`). A token is accepted when its `aud`
   * intersects this set. Defaults to `["solid", baseUrl]`.
   */
  readonly audience?: string | readonly string[];

  /**
   * Required access-token header `typ`. Solid-OIDC / RFC 9068 access tokens
   * carry `typ: at+jwt`; enforcing it stops an ID token or other issuer-signed
   * JWT sharing the same `iss`/`aud`/`webid` from being replayed as an access
   * token (token-type confusion). Compared case-insensitively, tolerating the
   * `application/at+jwt` media-type form. Set to `null` to skip the check for
   * issuers that omit `typ`. Defaults to `"at+jwt"`.
   */
  readonly accessTokenType?: string | null;

  /** Static JWK verification keys for the issuer (hermetic alternative to {@link jwksUri}). */
  readonly jwks?: Jwks;

  /** Issuer JWKS endpoint; fetched and cached when {@link jwks} is not given. */
  readonly jwksUri?: string;

  /**
   * Bodies larger than this (bytes) are offloaded to R2 as opaque blobs instead
   * of the DO SQLite quad store. Defaults to the ~2 MB DO-cell ceiling.
   */
  readonly maxInlineBytes?: number;

  /**
   * The documented read-replay tradeoff: reads MAY reuse a DPoP proof within
   * this many seconds (edge-cached window) rather than enforcing strict
   * single-use `jti`. Writes are always strict. Defaults to `0` (strict reads).
   */
  readonly readReplayWindowSeconds?: number;

  /**
   * Allow **unauthenticated** writes (`PUT`/`POST`/`PATCH`/`DELETE`) when WAC
   * grants the public agent class (`acl:agentClass foaf:Agent`) the needed
   * mode. Such requests carry no DPoP proof, so they get **no `jti` replay /
   * anti-abuse protection** — the "DPoP everywhere" guarantee does not hold for
   * them. Defaults to `false`: a tokenless write is refused `401` even where a
   * public-write ACL would otherwise permit it. Set `true` to opt into
   * public write as an explicit, documented tradeoff.
   */
  readonly allowAnonymousWrites?: boolean;

  /**
   * GC safety window (ms) advertised to the cron handler; an orphaned R2 object
   * is only reclaimed once it is older than this. MUST be ≥ the maximum write
   * duration. Defaults to five minutes.
   */
  readonly gcSafetyWindowMs?: number;

  /** Injectable clock (epoch ms) for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;

  /** `fetch` implementation used to resolve {@link jwksUri}; defaults to global `fetch`. */
  readonly fetch?: typeof fetch;

  /**
   * Override the edge authentication step entirely. When provided, the handler
   * calls this instead of the built-in JWKS + DPoP validation — useful for
   * tests and for issuers the default verifier does not cover. Returning
   * `null` means "no/invalid credentials" and the request proceeds
   * unauthenticated (WAC then decides public access).
   */
  readonly authenticate?: (
    request: Request,
  ) => Promise<AuthContext | null> | AuthContext | null;
}

/** The authenticated facts the front door hands to the Durable Object. */
export interface AuthContext {
  /** The authenticated agent's WebID. */
  readonly webid: string;
  /** The verified DPoP proof's `jti`, for write replay enforcement in the DO. */
  readonly jti: string;
  /** The DPoP key thumbprint the token is bound to (`cnf.jkt`). */
  readonly jkt: string;
}

/** Fully-resolved configuration with defaults applied. */
export interface ResolvedConfig {
  readonly baseUrl: string;
  readonly origin: string;
  readonly owners: readonly string[];
  readonly issuer?: string;
  readonly audience: readonly string[];
  readonly accessTokenType: string | null;
  readonly jwks?: Jwks;
  readonly jwksUri?: string;
  readonly maxInlineBytes?: number;
  readonly readReplayWindowSeconds: number;
  readonly allowAnonymousWrites: boolean;
  readonly gcSafetyWindowMs: number;
  readonly now: () => number;
  readonly fetch: typeof fetch;
  readonly authenticate?: SolidPodConfig["authenticate"];
}

/** Default GC safety window: five minutes, comfortably above any write. */
const DEFAULT_GC_SAFETY_WINDOW_MS = 5 * 60 * 1000;

/** Internal headers the trusted front door uses to hand auth facts to the DO. */
export const INTERNAL_HEADERS = {
  /** Authenticated agent WebID (absent ⇒ unauthenticated request). */
  webid: "x-solid-webid",
  /** Verified DPoP `jti` (present on authenticated writes for replay control). */
  jti: "x-solid-jti",
  /** Verified DPoP key thumbprint (`cnf.jkt`). */
  jkt: "x-solid-jkt",
  /** JSON-encoded subset of config the DO needs (offload threshold, etc.). */
  config: "x-solid-config",
} as const;

/** Strip the trailing slash from a base URL so path joins are unambiguous. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/** Apply defaults and derived values to raw {@link SolidPodConfig}. */
export function resolveConfig(config: SolidPodConfig): ResolvedConfig {
  if (!config.baseUrl) {
    throw new Error("@dwk/solid-pod: `baseUrl` is required");
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const origin = new URL(baseUrl).origin;
  const audience =
    config.audience === undefined
      ? ["solid", baseUrl]
      : typeof config.audience === "string"
        ? [config.audience]
        : [...config.audience];

  const owners =
    config.owner === undefined
      ? []
      : typeof config.owner === "string"
        ? [config.owner]
        : [...config.owner];

  return {
    baseUrl,
    origin,
    owners,
    issuer: config.issuer,
    audience,
    accessTokenType:
      config.accessTokenType === undefined ? "at+jwt" : config.accessTokenType,
    jwks: config.jwks,
    jwksUri: config.jwksUri,
    maxInlineBytes: config.maxInlineBytes,
    readReplayWindowSeconds: config.readReplayWindowSeconds ?? 0,
    allowAnonymousWrites: config.allowAnonymousWrites ?? false,
    gcSafetyWindowMs: config.gcSafetyWindowMs ?? DEFAULT_GC_SAFETY_WINDOW_MS,
    now: config.now ?? (() => Date.now()),
    fetch: config.fetch ?? fetch,
    authenticate: config.authenticate,
  };
}
