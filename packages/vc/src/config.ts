/**
 * Configuration for {@link ./handler.createVc}: the issuer DID and verification
 * method, the dynamic endpoint URLs, the (optional) status-list policy, and the
 * delegated authorization and DID-resolution hooks. Per the composition contract
 * the package never reads the global environment — every tunable arrives here and
 * signing-key material arrives via a secret binding — so a handler can be
 * instantiated multiple times and tested in isolation.
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";

import type { VerificationMethod } from "./data-integrity";
import { urlToDidWeb } from "./did-web";
import { DEFAULT_STATUS_LIST_LENGTH, type StatusPurpose } from "./status-list";

/** A mutating operation an {@link AuthorizeOperation} hook can gate. */
export type VcOperation = "issue" | "status";

/**
 * Authorization hook for the mutating endpoints (issue, status). Return `true`
 * to allow. When omitted, requests are allowed through — the composing Worker is
 * the front door and owns edge token validation (see `spec/architecture.md`);
 * supply this to enforce authorization inside the package as well.
 */
export type AuthorizeOperation = (
  operation: VcOperation,
  request: Request,
) => boolean | Promise<boolean>;

/** Resolve a verification-method id to its key document, or `undefined`. */
export type DidResolver = (
  id: string,
) => VerificationMethod | undefined | Promise<VerificationMethod | undefined>;

/** Status-list policy. */
export interface StatusConfig {
  /** Enable the status endpoints and `credentialStatus` issuance. */
  readonly enabled: boolean;
  /** The status purpose lists track. Defaults to `"revocation"`. */
  readonly statusPurpose?: StatusPurpose;
  /** Bit length of each status list. Defaults to {@link DEFAULT_STATUS_LIST_LENGTH}. */
  readonly listLength?: number;
}

/** Configuration passed to {@link ./handler.createVc}. */
export interface VcConfig {
  /** The identity root / base URL (e.g. `https://example.com`). */
  readonly baseUrl: string;
  /** The issuer DID. Defaults to the `did:web` derived from `baseUrl`. */
  readonly did?: string;
  /**
   * The verification method id used to sign credentials (e.g.
   * `did:web:example.com#key-0`). Defaults to `${did}#key-0`.
   */
  readonly verificationMethod?: string;
  /** Absolute issuance endpoint. Defaults to `${baseUrl}/credentials/issue`. */
  readonly issueEndpoint?: string;
  /** Absolute verification endpoint. Defaults to `${baseUrl}/credentials/verify`. */
  readonly verifyEndpoint?: string;
  /** Absolute status-update endpoint. Defaults to `${baseUrl}/credentials/status`. */
  readonly statusEndpoint?: string;
  /**
   * Absolute base URL under which signed status list credentials are served. A
   * request to `${statusListEndpoint}/<listId>` returns that list. Defaults to
   * `${baseUrl}/credentials/status-lists`.
   */
  readonly statusListEndpoint?: string;
  /** Status-list policy. Disabled by default. */
  readonly status?: StatusConfig;
  /** Authorization hook for issue/status (see {@link AuthorizeOperation}). */
  readonly authorize?: AuthorizeOperation;
  /**
   * Verification-method resolver used during verification. Defaults to a
   * `did:web` resolver over the global `fetch`.
   */
  readonly resolveDid?: DidResolver;
  /** Logger; defaults to a no-op. */
  readonly logger?: Logger;
  /** Metrics sink; defaults to a no-op. */
  readonly metrics?: Metrics;
}

/** Fully resolved configuration with defaults applied and URLs parsed. */
export interface ResolvedVcConfig {
  readonly did: string;
  readonly verificationMethod: string;
  readonly issueEndpoint: string;
  readonly verifyEndpoint: string;
  readonly statusEndpoint: string;
  readonly statusListEndpoint: string;
  readonly issuePath: string;
  readonly verifyPath: string;
  readonly statusPath: string;
  readonly statusListPath: string;
  readonly statusEnabled: boolean;
  readonly statusPurpose: StatusPurpose;
  readonly statusListLength: number;
  readonly authorize: AuthorizeOperation;
  readonly resolveDid?: DidResolver;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

function pathOf(absoluteUrl: string, label: string): string {
  try {
    return new URL(absoluteUrl).pathname;
  } catch {
    throw new Error(`@dwk/vc: ${label} is not a valid URL`);
  }
}

/**
 * Resolve user config into a {@link ResolvedVcConfig}: derive the issuer DID and
 * verification method from `baseUrl` when omitted, default each endpoint URL, and
 * pre-compute pathnames for routing. Throws if `baseUrl` (or any explicitly
 * supplied endpoint URL) is not a valid URL, or if status is enabled without a
 * status-list endpoint resolvable from `baseUrl`.
 */
export function resolveConfig(config: VcConfig): ResolvedVcConfig {
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new Error("@dwk/vc: `baseUrl` is not a valid URL");
  }
  const origin = base.origin;

  const did = config.did ?? urlToDidWeb(config.baseUrl);
  const verificationMethod = config.verificationMethod ?? `${did}#key-0`;

  const issueEndpoint = config.issueEndpoint ?? `${origin}/credentials/issue`;
  const verifyEndpoint =
    config.verifyEndpoint ?? `${origin}/credentials/verify`;
  const statusEndpoint =
    config.statusEndpoint ?? `${origin}/credentials/status`;
  const statusListEndpoint =
    config.statusListEndpoint ?? `${origin}/credentials/status-lists`;

  return {
    did,
    verificationMethod,
    issueEndpoint,
    verifyEndpoint,
    statusEndpoint,
    statusListEndpoint,
    issuePath: pathOf(issueEndpoint, "issueEndpoint"),
    verifyPath: pathOf(verifyEndpoint, "verifyEndpoint"),
    statusPath: pathOf(statusEndpoint, "statusEndpoint"),
    statusListPath: pathOf(statusListEndpoint, "statusListEndpoint"),
    statusEnabled: config.status?.enabled ?? false,
    statusPurpose: config.status?.statusPurpose ?? "revocation",
    statusListLength: config.status?.listLength ?? DEFAULT_STATUS_LIST_LENGTH,
    authorize: config.authorize ?? (() => true),
    resolveDid: config.resolveDid,
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}
