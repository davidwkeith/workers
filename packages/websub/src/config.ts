/**
 * `@dwk/websub` — injected configuration and the Cloudflare `Env` fragment.
 *
 * Per the composition contract, a package never reads the global environment
 * directly: all config (base URL, the topics this hub serves, lease bounds) is
 * passed into {@link createWebSub}, so the hub can be instantiated multiple times
 * and unit-tested in isolation. The Cloudflare bindings the hub needs are
 * declared as a TypeScript `Env` fragment that the composed Worker's `Env` is a
 * superset of. See `spec/composition-contract.md` and `spec/packages/websub.md`.
 *
 * @packageDocumentation
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import {
  DEFAULT_SIGNATURE_ALGORITHM,
  type SignatureAlgorithm,
} from "./distribute";
import type { FetchLike } from "./fetch";
import type { WebSubJob } from "./queue";

/**
 * Cloudflare bindings required by the hub handler and its queue consumer.
 *
 * The subscription store **MUST** be strongly consistent — D1 (session
 * consistency), never KV: a stale or lost subscription is a correctness bug, not
 * a safe-to-be-stale cache (`spec/non-functional-requirements.md`).
 */
export interface WebSubEnv {
  /** D1 database backing the subscription table. */
  readonly WEBSUB_DB: D1Database;
  /** Queue for intent verification and content-distribution fan-out + retries. */
  readonly WEBSUB_QUEUE: Queue<WebSubJob>;
}

/** Configuration passed to {@link createWebSub}. */
export interface WebSubConfig {
  /** Base URL of this hub; informational and used for self-advertisement. */
  readonly baseUrl: string;
  /**
   * Absolute URL of the hub endpoint itself, advertised to subscribers in the
   * `rel="hub"` `Link` header on each delivery. Defaults to {@link baseUrl};
   * set it when the hub is mounted under a path prefix.
   */
  readonly hubUrl?: string;
  /**
   * The topic URLs this hub will serve (the user's own feeds). A subscribe or
   * publish request for any other topic is rejected. Compared by normalized URL
   * (default ports and a trailing-slash-only path are folded). Provide either
   * this or {@link isAllowedTopic}.
   */
  readonly allowedTopics?: readonly string[];
  /**
   * Predicate deciding whether a topic URL is one this hub serves, for callers
   * whose feed set is dynamic. Takes precedence over {@link allowedTopics}.
   */
  readonly isAllowedTopic?: (topic: string) => boolean;
  /** Minimum lease (seconds) the hub will grant. Default 300 (5 minutes). */
  readonly minLeaseSeconds?: number;
  /** Maximum lease (seconds) the hub will grant. Default 864000 (10 days). */
  readonly maxLeaseSeconds?: number;
  /**
   * Lease granted when a subscriber omits `hub.lease_seconds`. Default 864000
   * (10 days). Clamped into `[minLeaseSeconds, maxLeaseSeconds]`.
   */
  readonly defaultLeaseSeconds?: number;
  /**
   * HMAC digest method for the `X-Hub-Signature` on signed deliveries (WebSub
   * §8 permits `sha1`/`sha256`/`sha384`/`sha512`). WebSub has no per-request
   * method parameter, so this is a hub-level choice; it defaults to the secure
   * `sha256`. Set it to `sha1` **only** when a subscriber requires the legacy
   * method for interop — SHA-1 is weaker and not the default for that reason.
   */
  readonly signatureAlgorithm?: SignatureAlgorithm;
  /** `fetch` implementation for verification/distribution; defaults to global `fetch`. */
  readonly fetch?: FetchLike;
  /** Logger; defaults to a no-op (see `@dwk/log`). */
  readonly logger?: Logger;
  /** Metrics sink; defaults to a no-op (see `@dwk/log`). */
  readonly metrics?: Metrics;
}

/** Default lower bound on a granted lease (5 minutes). */
export const DEFAULT_MIN_LEASE_SECONDS = 300;
/** Default upper bound on a granted lease (10 days). */
export const DEFAULT_MAX_LEASE_SECONDS = 864_000;

/** Config with defaults resolved and the topic check normalized to a predicate. */
export interface ResolvedConfig {
  readonly baseUrl: string;
  readonly hubUrl: string;
  readonly isAllowedTopic: (topic: string) => boolean;
  readonly minLeaseSeconds: number;
  readonly maxLeaseSeconds: number;
  readonly defaultLeaseSeconds: number;
  readonly signatureAlgorithm: SignatureAlgorithm;
  readonly fetch: FetchLike;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/**
 * Normalize a topic URL for comparison: lowercase host, default port dropped,
 * a bare `/` path elided, and fragment removed. Query strings are preserved
 * (a feed may legitimately carry one). Returns `null` when `raw` is unparseable
 * or not `http(s)`.
 */
export function normalizeTopic(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  url.hash = "";
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/**
 * Resolve {@link WebSubConfig} into {@link ResolvedConfig}, filling defaults and
 * turning the topic allowlist into a single predicate.
 *
 * @throws when neither `allowedTopics` nor `isAllowedTopic` is supplied — a hub
 * with no topics would accept subscriptions it can never serve.
 */
export function resolveConfig(config: WebSubConfig): ResolvedConfig {
  const min = config.minLeaseSeconds ?? DEFAULT_MIN_LEASE_SECONDS;
  const max = config.maxLeaseSeconds ?? DEFAULT_MAX_LEASE_SECONDS;
  if (min > max) {
    throw new Error(
      `@dwk/websub: minLeaseSeconds (${min}) exceeds maxLeaseSeconds (${max}).`,
    );
  }
  const fallback = config.defaultLeaseSeconds ?? DEFAULT_MAX_LEASE_SECONDS;
  const defaultLeaseSeconds = Math.min(Math.max(fallback, min), max);

  let isAllowedTopic: (topic: string) => boolean;
  if (config.isAllowedTopic !== undefined) {
    isAllowedTopic = config.isAllowedTopic;
  } else if (config.allowedTopics !== undefined) {
    const allowed = new Set<string>();
    for (const topic of config.allowedTopics) {
      const normalized = normalizeTopic(topic);
      if (normalized !== null) {
        allowed.add(normalized);
      }
    }
    isAllowedTopic = (topic) => {
      const normalized = normalizeTopic(topic);
      return normalized !== null && allowed.has(normalized);
    };
  } else {
    throw new Error(
      "@dwk/websub: configure allowedTopics or isAllowedTopic — a hub must " +
        "know which topics it serves.",
    );
  }

  return {
    baseUrl: config.baseUrl,
    hubUrl: config.hubUrl ?? config.baseUrl,
    isAllowedTopic,
    minLeaseSeconds: min,
    maxLeaseSeconds: max,
    defaultLeaseSeconds,
    signatureAlgorithm:
      config.signatureAlgorithm ?? DEFAULT_SIGNATURE_ALGORITHM,
    fetch: config.fetch ?? ((input, init) => fetch(input, init)),
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}

/** Clamp a requested lease into the hub's `[min, max]` bounds. */
export function clampLease(requested: number, config: ResolvedConfig): number {
  return Math.min(
    Math.max(requested, config.minLeaseSeconds),
    config.maxLeaseSeconds,
  );
}
