/**
 * `@dwk/microsub` — injected configuration and the Cloudflare `Env` fragment.
 *
 * Per the composition contract a package never reads the global environment
 * directly: all config (base URL, owner `me`, endpoint URL, page size, poll
 * cadence) is passed into {@link createMicrosub}, so the server can be
 * instantiated multiple times and unit-tested in isolation. The Cloudflare
 * bindings it needs are declared as a TypeScript `Env` fragment that the
 * composed Worker's `Env` is a superset of. See `spec/composition-contract.md`
 * and `spec/packages/microsub.md`.
 *
 * @packageDocumentation
 */

import { canonicalizeProfileUrl } from "@dwk/indieauth";
import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";
import type { D1Database, Queue } from "@cloudflare/workers-types";

import type { FetchLike } from "./fetch.js";
import type { MicrosubJob } from "./queue.js";

/**
 * Cloudflare bindings required by the Microsub handler, poller, and queue
 * consumer.
 *
 * The subscription + timeline store **MUST** be strongly consistent — D1
 * (session consistency), never KV: a lost subscription or a dropped read-state
 * flag is a correctness bug, not a safe-to-be-stale cache
 * (`spec/non-functional-requirements.md`).
 */
export interface MicrosubEnv {
  /** D1 database for channels, follows, timeline items, and the poll cache. */
  readonly MICROSUB_DB: D1Database;
  /** Queue for feed-poll fan-out and retries. */
  readonly MICROSUB_QUEUE: Queue<MicrosubJob>;
  /** The `@dwk/indieauth` issued-token store (D1), consulted for revocation. */
  readonly AUTH_DB: D1Database;
  /** HMAC key the IndieAuth token endpoint signed access tokens with. */
  readonly TOKEN_SIGNING_KEY: string;
}

/** Configuration passed to {@link createMicrosub} and its poller/consumer. */
export interface MicrosubConfig {
  /** The identity root / base URL (e.g. `https://example.com`). */
  readonly baseUrl: string;
  /**
   * The site owner's IndieAuth profile URL (`me`). A token only authorizes a
   * request when its subject (`sub`) equals this, after canonicalization — so a
   * token minted by the same issuer for a *different* `me` cannot read here.
   * Required: a Microsub endpoint serves exactly one user.
   */
  readonly me: string;
  /** Absolute Microsub endpoint URL. Defaults to `${origin}/microsub`. */
  readonly microsubEndpoint?: string;
  /**
   * Expected access-token issuer (`iss`). Defaults to `baseUrl`, matching the
   * `@dwk/indieauth` issuer default.
   */
  readonly tokenIssuer?: string;
  /** Default timeline page size. Defaults to 20. */
  readonly pageSize?: number;
  /**
   * Per-channel retention ceiling: when a poll pushes a channel above this, the
   * oldest items are reaped. Defaults to 5000. Keeps a runaway feed from filling
   * the D1 store unbounded.
   */
  readonly maxItemsPerChannel?: number;
  /**
   * Whether to check each token against the issued-token store (revocation).
   * Defaults to `true` — staleness here is a security bug, so the check hits the
   * strongly-consistent `AUTH_DB` rather than any cache.
   */
  readonly checkRevocation?: boolean;
  /**
   * Whether to reject replayed DPoP proofs on state-changing (`POST`) requests
   * by tracking each accepted proof's `jti` in the strongly-consistent
   * `MICROSUB_DB`. Defaults to `true`.
   */
  readonly checkDpopReplay?: boolean;
  /** `fetch` implementation for discovery/polling/preview; defaults to global `fetch`. */
  readonly fetch?: FetchLike;
  /** Logger; defaults to a no-op (see `@dwk/log`). */
  readonly logger?: Logger;
  /** Metrics sink; defaults to a no-op (see `@dwk/log`). */
  readonly metrics?: Metrics;
}

/** Fully resolved configuration with defaults applied and the path parsed. */
export interface ResolvedConfig {
  readonly me: string;
  readonly microsubEndpoint: string;
  readonly microsubPath: string;
  readonly tokenIssuer: string;
  readonly pageSize: number;
  readonly maxItemsPerChannel: number;
  readonly checkRevocation: boolean;
  readonly checkDpopReplay: boolean;
  readonly fetch: FetchLike;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_ITEMS = 5000;

function pathOf(absoluteUrl: string, label: string): string {
  try {
    return new URL(absoluteUrl).pathname;
  } catch {
    throw new Error(`@dwk/microsub: ${label} is not a valid URL`);
  }
}

/**
 * Resolve user config into a {@link ResolvedConfig}, applying defaults and
 * pre-computing the endpoint pathname for request routing. Throws if `baseUrl`
 * or `me` (or an explicitly supplied endpoint URL) is invalid.
 */
export function resolveConfig(config: MicrosubConfig): ResolvedConfig {
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new Error("@dwk/microsub: `baseUrl` is not a valid URL");
  }

  const me = canonicalizeProfileUrl(config.me);
  if (me === null) {
    throw new Error("@dwk/microsub: `me` is not a valid profile URL");
  }

  const microsubEndpoint = config.microsubEndpoint ?? `${base.origin}/microsub`;

  const pageSize =
    config.pageSize !== undefined && config.pageSize > 0
      ? Math.floor(config.pageSize)
      : DEFAULT_PAGE_SIZE;
  const maxItemsPerChannel =
    config.maxItemsPerChannel !== undefined && config.maxItemsPerChannel > 0
      ? Math.floor(config.maxItemsPerChannel)
      : DEFAULT_MAX_ITEMS;

  return {
    me,
    microsubEndpoint,
    microsubPath: pathOf(microsubEndpoint, "microsubEndpoint"),
    tokenIssuer: config.tokenIssuer ?? config.baseUrl,
    pageSize,
    maxItemsPerChannel,
    checkRevocation: config.checkRevocation ?? true,
    checkDpopReplay: config.checkDpopReplay ?? true,
    fetch: config.fetch ?? ((input, init) => fetch(input, init)),
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}
