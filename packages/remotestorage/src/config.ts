/**
 * Configuration, the declared Cloudflare `Env` fragment, and config resolution
 * for `@dwk/remotestorage`.
 *
 * Per the composition contract the package never reads the global environment
 * directly: all tunables (base URL, token issuer/JWKS, accepted audience,
 * offload threshold, GC window, path mapping) are passed into
 * {@link createRemoteStorage} / {@link createRemoteStorageGc}, so a vault can be
 * instantiated multiple times and unit-tested in isolation. The Cloudflare
 * bindings — the per-account Durable Object namespace and the R2 blob bucket —
 * are the only runtime coupling, and a missing one fails loudly at startup.
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";

import type { RemoteStorageAuth } from "./auth";
import type { RemoteStorageObject } from "./storage";

/** Cloudflare bindings required by the handler and the per-account Durable Object. */
export interface RemoteStorageEnv {
  /** Durable Object namespace for the per-account class ({@link RemoteStorageObject}). */
  readonly STORAGE: DurableObjectNamespace<RemoteStorageObject>;
  /** R2 bucket holding document bodies (MAY be shared with `@dwk/solid-pod`). */
  readonly BLOBS: R2Bucket;
  /**
   * Shared D1 database tracking orphaned blob keys for the out-of-band GC cron.
   * Optional: when bound, the DO forwards its transactional orphan outbox here
   * after writes so {@link createRemoteStorageGc} can reclaim them without ever
   * waking a Durable Object.
   */
  readonly GC_DB?: D1Database;
}

/** Cloudflare bindings required by the out-of-band R2 garbage-collection cron. */
export interface RemoteStorageGcEnv {
  /** R2 bucket holding document bodies. */
  readonly BLOBS: R2Bucket;
  /** Shared D1 database tracking orphaned blob keys (see `@dwk/store`). */
  readonly GC_DB: D1Database;
}

/** The account and account-relative storage path parsed from a request URL. */
export interface ParsedPath {
  /** Stable account identifier; keys the per-account Durable Object. */
  readonly account: string;
  /** Account-relative storage path, percent-encoded, always starting with `/`. */
  readonly path: string;
}

/** Configuration passed to {@link createRemoteStorage}. */
export interface RemoteStorageConfig {
  /**
   * The storage server's base URL, e.g. `https://storage.example`. Used for
   * discovery metadata and as a default token audience. No trailing slash.
   */
  readonly baseUrl: string;

  /**
   * Accepted access-token issuer (`iss`). When set, a token whose `iss` differs
   * is rejected. Ignored when a custom {@link authenticate} hook is supplied.
   */
  readonly issuer?: string;

  /**
   * Accepted token audience(s) (`aud`). When set, a token is accepted only when
   * its `aud` intersects this set; when unset the audience check is skipped
   * (plain OAuth bearer tokens often omit `aud`).
   */
  readonly audience?: string | readonly string[];

  /** Static JWK verification keys for the issuer (hermetic alternative to {@link jwksUri}). */
  readonly jwks?: readonly JsonWebKey[];

  /** Issuer JWKS endpoint; fetched and cached when {@link jwks} is not given. */
  readonly jwksUri?: string;

  /**
   * Bodies larger than this (bytes) are offloaded to R2 as opaque blobs instead
   * of the DO SQLite cell. Defaults to the ~2 MB DO-cell ceiling in `@dwk/store`.
   */
  readonly maxInlineBytes?: number;

  /**
   * GC safety window (ms) advertised to the cron handler; an orphaned R2 object
   * is reclaimed only once it is older than this. MUST be ≥ the maximum write
   * duration. Defaults to five minutes.
   */
  readonly gcSafetyWindowMs?: number;

  /** Injectable clock (epoch ms) for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;

  /** `fetch` implementation used to resolve {@link jwksUri}; defaults to global `fetch`. */
  readonly fetch?: typeof fetch;

  /**
   * Override the bearer-token verification entirely. When provided, the handler
   * calls this instead of the built-in JWKS verifier — useful for tests and for
   * token formats the default verifier does not cover (e.g. opaque tokens
   * resolved via RFC 7662 introspection). Returning `null` means "no/invalid
   * credentials"; the request then proceeds unauthenticated (only `/public/`
   * document reads succeed).
   */
  readonly authenticate?: (
    request: Request,
  ) => Promise<RemoteStorageAuth | null> | RemoteStorageAuth | null;

  /**
   * Map a request `pathname` to an {@link ParsedPath}. Defaults to treating the
   * first path segment as the account and the remainder (with leading slash) as
   * the account-relative storage path: `/alice/documents/x` → account `alice`,
   * path `/documents/x`; `/alice` or `/alice/` → account `alice`, path `/`.
   * Return `null` to 404 a request that names no account.
   */
  readonly parsePath?: (pathname: string) => ParsedPath | null;

  /** Logger for auth/authz events; defaults to a no-op (see `@dwk/log`). */
  readonly logger?: Logger;
  /** Metrics sink for the same events; defaults to a no-op. */
  readonly metrics?: Metrics;
}

/** Fully-resolved configuration with defaults applied. */
export interface ResolvedConfig {
  readonly baseUrl: string;
  readonly issuer?: string;
  readonly audience: readonly string[];
  readonly jwks?: readonly JsonWebKey[];
  readonly jwksUri?: string;
  readonly maxInlineBytes?: number;
  readonly gcSafetyWindowMs: number;
  readonly now: () => number;
  readonly fetch: typeof fetch;
  readonly authenticate?: RemoteStorageConfig["authenticate"];
  readonly parsePath: (pathname: string) => ParsedPath | null;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/** Default GC safety window: five minutes, comfortably above any write. */
const DEFAULT_GC_SAFETY_WINDOW_MS = 5 * 60 * 1000;

/** Internal header the trusted front door uses to hand config to the DO. */
export const INTERNAL_HEADERS = {
  /** JSON-encoded subset of config the DO needs (offload threshold). */
  config: "x-remotestorage-config",
} as const;

/** Strip the trailing slash from a base URL so joins are unambiguous. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * Default {@link RemoteStorageConfig.parsePath}: first segment is the account,
 * the rest (with leading slash) is the storage path. Returns `null` when the
 * path names no account (e.g. `/`).
 */
export function defaultParsePath(pathname: string): ParsedPath | null {
  const match = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const account = decodeURIComponent(match[1] as string);
  // Keep the storage path percent-encoded: decoding `%2F` would conflate it
  // with a real separator and corrupt store keys.
  const path = match[2] ?? "/";
  return { account, path };
}

/** Apply defaults and derived values to raw {@link RemoteStorageConfig}. */
export function resolveConfig(config: RemoteStorageConfig): ResolvedConfig {
  if (!config.baseUrl) {
    throw new Error("@dwk/remotestorage: `baseUrl` is required");
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const audience =
    config.audience === undefined
      ? []
      : typeof config.audience === "string"
        ? [config.audience]
        : [...config.audience];

  return {
    baseUrl,
    issuer: config.issuer,
    audience,
    jwks: config.jwks,
    jwksUri: config.jwksUri,
    maxInlineBytes: config.maxInlineBytes,
    gcSafetyWindowMs: config.gcSafetyWindowMs ?? DEFAULT_GC_SAFETY_WINDOW_MS,
    now: config.now ?? (() => Date.now()),
    fetch: config.fetch ?? fetch,
    authenticate: config.authenticate,
    parsePath: config.parsePath ?? defaultParsePath,
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}
