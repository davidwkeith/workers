/**
 * Configuration, the declared Cloudflare `Env` fragment, and config resolution
 * for `@dwk/atproto-pds`.
 *
 * Per the composition contract the package never reads the global environment
 * directly: the account identity, credentials, and limits are all passed into
 * {@link createAtprotoPds}, so the PDS can be instantiated multiple times and
 * unit-tested in isolation. The repository signing key is **not** configured —
 * it is generated inside and never leaves the per-account Durable Object — so
 * key custody stays as tight as possible. Missing bindings fail loudly.
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";

import type { SigningCurve } from "./crypto.js";
import { didWebFromHost, isValidHandle } from "./identity.js";
import type { AtprotoRepoObject } from "./object.js";

/** Cloudflare bindings required by the PDS handler and repository DO. */
export interface AtprotoPdsEnv {
  /**
   * Durable Object namespace for the per-account repository class
   * ({@link AtprotoRepoObject}): the single authority for the MST, the signed
   * commit chain, the repository signing key, and session issuance.
   */
  readonly REPO: DurableObjectNamespace<AtprotoRepoObject>;
  /** R2 bucket holding blob bodies (`uploadBlob` → `getBlob`). */
  readonly BLOBS: R2Bucket;
}

/** Configuration passed to {@link createAtprotoPds}. */
export interface AtprotoPdsConfig {
  /**
   * The PDS origin / identity root, e.g. `https://alice.example.com`. The
   * account's `did:web`, handle, and the `serviceEndpoint` in its DID document
   * all derive from it. No trailing slash.
   */
  readonly baseUrl: string;

  /**
   * The account handle (a domain name). Defaults to the host of {@link baseUrl}.
   * Federated apps resolve `at://<handle>` to the account DID.
   */
  readonly handle?: string;

  /**
   * The account DID. For `did:web` (the default method) it defaults to the
   * `did:web` derived from {@link baseUrl}'s host. For `did:plc` it is normally
   * **omitted** and derived by the Durable Object from the signed genesis
   * operation; supply it only to adopt an existing `did:plc` (e.g. migration).
   */
  readonly did?: string;

  /**
   * The DID method for this account. `"web"` (default) keeps identity at the
   * user's own origin with no external directory. `"plc"` anchors the DID in the
   * public PLC directory — required to interoperate with the bulk of the existing
   * network, at the cost of a dependency on that directory. Fixed at genesis.
   */
  readonly didMethod?: "web" | "plc";

  /**
   * PLC directory base URL. When set **and** {@link didMethod} is `"plc"`, the
   * Durable Object submits its freshly minted genesis operation here at creation,
   * registering the account on the network. Defaults to **undefined** — no
   * automatic submission, so the account is locally self-consistent and can be
   * registered later (and so tests never reach the network). Set to
   * `"https://plc.directory"` to register against the public directory.
   */
  readonly plcDirectoryUrl?: string;

  /**
   * The repository commit-signing curve. Defaults to `"p256"` — the
   * dependency-free, self-hosted-friendly default. Set `"secp256k1"` for the
   * AT Protocol network-preferred curve (required to be a drop-in for an
   * existing account; see account migration). The curve is fixed at repository
   * genesis and cannot change for an already-initialised account.
   */
  readonly signingCurve?: SigningCurve;

  /**
   * The account password (a secret binding's value) accepted by
   * `com.atproto.server.createSession`. Required to issue sessions; omit it for
   * a read-only deployment that serves the repository but accepts no writes.
   */
  readonly password?: string;

  /**
   * HS256 signing secret for session JWTs (a secret binding's value). Required
   * whenever {@link password} is set.
   */
  readonly jwtSecret?: string;

  /** Access-token lifetime in seconds. Defaults to 7200 (2 hours). */
  readonly accessTokenTtlSeconds?: number;
  /** Refresh-token lifetime in seconds. Defaults to 7776000 (90 days). */
  readonly refreshTokenTtlSeconds?: number;
  /** Maximum accepted blob size in bytes. Defaults to 5 MiB. */
  readonly maxBlobSizeBytes?: number;
  /**
   * Maximum size in bytes of a `#commit` event's blocks CAR before the firehose
   * marks it `tooBig` (sending an empty CAR and no ops, so a consumer falls back
   * to `getRepo`). Defaults to 1 MiB — under the Workers WebSocket message
   * ceiling, and a natural cap given the whole MST is rebuilt into each frame.
   */
  readonly firehoseMaxBlocksBytes?: number;

  /** Injectable clock (epoch ms) for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Structured-logging seam; defaults to a no-op. */
  readonly logger?: Logger;
  /** Metrics seam; defaults to a no-op. */
  readonly metrics?: Metrics;
}

/** Fully-resolved configuration with defaults applied. */
export interface ResolvedConfig {
  readonly baseUrl: string;
  readonly host: string;
  readonly handle: string;
  /**
   * The account DID. For `did:web` it is always known up front. For a fresh
   * `did:plc` account it is the empty string here — the DID is only known after
   * the DO signs its genesis operation, so the front door routes by
   * {@link accountKey} and forwards identity queries to the DO.
   */
  readonly did: string;
  readonly didMethod: "web" | "plc";
  readonly plcDirectoryUrl?: string;
  /** Stable per-account routing key for the DO (the host), method-independent. */
  readonly accountKey: string;
  readonly signingCurve: SigningCurve;
  readonly password?: string;
  readonly jwtSecret?: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly maxBlobSizeBytes: number;
  readonly firehoseMaxBlocksBytes: number;
  readonly now: () => number;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/**
 * Internal header the trusted front door uses to hand the DO the config subset
 * it needs (identity, credentials, limits). The signing key is never included —
 * it lives only inside the DO.
 */
export const INTERNAL_CONFIG_HEADER = "x-atproto-config";

/** The config subset forwarded to the DO. */
export interface ForwardedConfig {
  readonly did: string;
  readonly didMethod: "web" | "plc";
  readonly plcDirectoryUrl?: string;
  readonly handle: string;
  readonly baseUrl: string;
  readonly signingCurve: SigningCurve;
  readonly password?: string;
  readonly jwtSecret?: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly maxBlobSizeBytes: number;
  readonly firehoseMaxBlocksBytes: number;
}

const DEFAULT_ACCESS_TTL = 7200;
const DEFAULT_REFRESH_TTL = 90 * 24 * 60 * 60;
const DEFAULT_MAX_BLOB = 5 * 1024 * 1024;
const DEFAULT_FIREHOSE_MAX_BLOCKS = 1024 * 1024;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/** Apply defaults and derive identity from raw {@link AtprotoPdsConfig}. */
export function resolveConfig(config: AtprotoPdsConfig): ResolvedConfig {
  if (!config.baseUrl) {
    throw new Error("@dwk/atproto-pds: `baseUrl` is required");
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const host = new URL(baseUrl).host;
  const handle = config.handle ?? new URL(baseUrl).hostname;
  if (!isValidHandle(handle)) {
    throw new Error(`@dwk/atproto-pds: invalid handle \`${handle}\``);
  }
  if (config.password && !config.jwtSecret) {
    throw new Error(
      "@dwk/atproto-pds: `jwtSecret` is required when `password` is set",
    );
  }
  const didMethod = config.didMethod ?? "web";
  if (config.did) {
    const expected = didMethod === "plc" ? "did:plc:" : "did:web:";
    if (!config.did.startsWith(expected)) {
      throw new Error(
        `@dwk/atproto-pds: \`did\` \`${config.did}\` does not match didMethod \`${didMethod}\` (expected a \`${expected}…\` DID)`,
      );
    }
  }
  // did:web is always known up front; a fresh did:plc DID is derived by the DO
  // from its genesis operation, so it is empty here unless explicitly adopted.
  const did = config.did ?? (didMethod === "web" ? didWebFromHost(host) : "");
  return {
    baseUrl,
    host,
    handle,
    did,
    didMethod,
    ...(config.plcDirectoryUrl
      ? { plcDirectoryUrl: config.plcDirectoryUrl }
      : {}),
    accountKey: host,
    signingCurve: config.signingCurve ?? "p256",
    password: config.password,
    jwtSecret: config.jwtSecret,
    accessTokenTtlSeconds: config.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TTL,
    refreshTokenTtlSeconds:
      config.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL,
    maxBlobSizeBytes: config.maxBlobSizeBytes ?? DEFAULT_MAX_BLOB,
    firehoseMaxBlocksBytes:
      config.firehoseMaxBlocksBytes ?? DEFAULT_FIREHOSE_MAX_BLOCKS,
    now: config.now ?? (() => Date.now()),
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}

/** Build the config subset the front door forwards to the DO. */
export function forwardedConfig(config: ResolvedConfig): ForwardedConfig {
  return {
    did: config.did,
    didMethod: config.didMethod,
    ...(config.plcDirectoryUrl
      ? { plcDirectoryUrl: config.plcDirectoryUrl }
      : {}),
    handle: config.handle,
    baseUrl: config.baseUrl,
    signingCurve: config.signingCurve,
    ...(config.password ? { password: config.password } : {}),
    ...(config.jwtSecret ? { jwtSecret: config.jwtSecret } : {}),
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
    maxBlobSizeBytes: config.maxBlobSizeBytes,
    firehoseMaxBlocksBytes: config.firehoseMaxBlocksBytes,
  };
}
