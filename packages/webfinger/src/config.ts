/**
 * Configuration for {@link createWebfinger}: the set of resources this server
 * controls (a static map, a resolver function, or both) plus the optional
 * logging/metrics seams. Per the composition contract the package never reads
 * the global environment — every resource mapping arrives here, so a handler can
 * be instantiated multiple times and tested in isolation.
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";

import type { ResourceRecord } from "./jrd";
import { normalizeResource } from "./resource";

/**
 * A dynamic resolver from a queried `resource` URI to its {@link ResourceRecord},
 * or `undefined` when this server does not control the resource (→ `404`). The
 * `resource` is passed **normalized** (lowercased scheme/host per RFC 7033 §4.1),
 * so a resolver can compare it directly without re-normalizing. The matched
 * `rel` filters are passed through so a resolver backed by stored data (e.g. a
 * profile document via `@dwk/rdf`) can avoid materialising links it is about to
 * discard, but applying the filter is optional — the handler always re-applies
 * {@link filterLinksByRel} to whatever is returned.
 */
export type ResourceResolver = (
  resource: string,
  rels: readonly string[],
) => ResourceRecord | undefined | Promise<ResourceRecord | undefined>;

/** Configuration passed to {@link createWebfinger}. */
export interface WebfingerConfig {
  /**
   * Static map of controlled `resource` URI → its descriptor. Keys are the
   * exact `resource` values clients query (`acct:user@example.com`,
   * `https://example.com/`, `mailto:user@example.com`). Consulted before
   * {@link resolve}.
   */
  readonly resources?: Readonly<Record<string, ResourceRecord>>;
  /**
   * Dynamic fallback consulted when {@link resources} has no entry for the
   * queried URI. At least one of {@link resources} or `resolve` MUST be
   * supplied, or {@link createWebfinger} throws at construction time.
   */
  readonly resolve?: ResourceResolver;
  /**
   * Logger for discovery events; defaults to a no-op. Wire a real logger (see
   * `@dwk/log`) to surface unknown-resource probes and method rejections instead
   * of swallowing them.
   */
  readonly logger?: Logger;
  /**
   * Metrics sink for discovery counters; defaults to a no-op. Wire an adapter
   * (e.g. `analyticsEngineMetrics` from `@dwk/log`) to chart the same events the
   * logger names — "lookups/min", "404 rate", "rel-filtered lookups".
   */
  readonly metrics?: Metrics;
}

/** Configuration after defaults are filled and a unified resolver is built. */
export interface ResolvedConfig {
  /** Look up a resource: static map first, then the dynamic resolver. */
  readonly resolve: (
    resource: string,
    rels: readonly string[],
  ) => Promise<ResourceRecord | undefined>;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/**
 * Validate and normalise a {@link WebfingerConfig}. Fails loudly when neither a
 * resource map nor a resolver is configured — a WebFinger endpoint that controls
 * no resources is always a misconfiguration, not a silent "everything is a 404".
 * Returns a single `resolve` that consults the static map first (an O(1) exact
 * match) and then the dynamic resolver.
 */
export function resolveConfig(config: WebfingerConfig): ResolvedConfig {
  if (config.resources === undefined && config.resolve === undefined) {
    throw new Error(
      "@dwk/webfinger: configure `resources` and/or `resolve` — a WebFinger " +
        "endpoint must control at least one resource source.",
    );
  }

  // Key the static map by the normalized resource URI so matching is
  // case-insensitive on scheme/host (RFC 7033 §4.1). When two configured keys
  // normalize to the same value, the later entry wins.
  const normalizedMap =
    config.resources === undefined
      ? undefined
      : new Map(
          Object.entries(config.resources).map(([key, record]) => [
            normalizeResource(key),
            record,
          ]),
        );
  const dynamicResolve = config.resolve;

  const resolve = async (
    resource: string,
    rels: readonly string[],
  ): Promise<ResourceRecord | undefined> => {
    const key = normalizeResource(resource);
    if (normalizedMap !== undefined) {
      const record = normalizedMap.get(key);
      if (record !== undefined) {
        return record;
      }
    }
    if (dynamicResolve !== undefined) {
      return await dynamicResolve(key, rels);
    }
    return undefined;
  };

  return {
    resolve,
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}
