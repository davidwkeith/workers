/**
 * The shared logging/metrics seam used by every endpoint. Logging and metrics
 * are opt-in (default no-op) and share one event vocabulary (see `./log` and
 * `@dwk/log`): the same dotted event name flows to both the logger and the
 * metrics sink so a log line and its counter line up.
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";
import type { LogFields } from "@dwk/log";

/** Observability config fragment mixed into each handler's config. */
export interface ObservabilityConfig {
  /**
   * Logger for endpoint events; defaults to a no-op. Wire a real logger (see
   * `@dwk/log`) to surface introspection refusals, registration rejections, and
   * the like instead of swallowing them.
   */
  readonly logger?: Logger;
  /**
   * Metrics sink for the same events; defaults to a no-op. Wire an adapter (e.g.
   * `analyticsEngineMetrics` from `@dwk/log`) to chart what the logger names.
   */
  readonly metrics?: Metrics;
}

/** A resolved logger/metrics pair, defaults applied. */
export interface Observability {
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/** Resolve the optional observability config to concrete (no-op) sinks. */
export function resolveObservability(
  config: ObservabilityConfig,
): Observability {
  return {
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}

/**
 * Emit a structured event on both the logger and the metrics sink. `warn` for
 * handled-but-notable rejections, `info` for normal outcomes. Honors the
 * redaction policy — callers pass only reason codes, sanitized hosts, and
 * scopes, never tokens, secrets, or `request_uri` references.
 */
export function emit(
  obs: Observability,
  level: "info" | "warn",
  event: string,
  fields?: LogFields,
): void {
  obs.logger[level](event, fields);
  obs.metrics.count(event, fields);
}
