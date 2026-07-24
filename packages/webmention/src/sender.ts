/**
 * `@dwk/webmention` — sender.
 *
 * On publish, notify each outbound target: discover its Webmention endpoint
 * (see {@link discoverEndpoint}) and POST a `source`/`target` notification as
 * `application/x-www-form-urlencoded`. See `spec/packages/webmention.md`.
 *
 * @packageDocumentation
 */

import {
  hostFromUrl,
  noopLogger,
  noopMetrics,
  type Logger,
  type Metrics,
} from "@dwk/log";
import { safeFetch, type FetchLike } from "@dwk/safe-fetch";
import { discoverEndpoint } from "./discovery.js";
import { WebmentionLogEvent } from "./log.js";
import type { SentLog } from "./sent-log.js";

/** Options for {@link sendWebmention} / {@link sendWebmentions}. */
export interface SendOptions {
  /** `fetch` implementation to use; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Logger for send outcomes; defaults to a no-op (see `@dwk/log`). */
  readonly logger?: Logger;
  /** Metrics sink for send-outcome counters; defaults to a no-op (see `@dwk/log`). */
  readonly metrics?: Metrics;
  /**
   * Local-dev opt-in passed through to `@dwk/safe-fetch`'s `allowedHosts`:
   * exact `host[:port]` entries exempted from the SSRF private/loopback host
   * block (e.g. `["localhost:4321"]` under `wrangler dev --local`). Never
   * enable in a production composition.
   */
  readonly fetchAllowedHosts?: readonly string[];
  /**
   * Opt-in delivered-notification log (see `sent-log.ts`). When supplied,
   * every accepted notification is recorded so
   * {@link resendForDeletedSource} can honor Webmention §3.1.5 after the
   * source is deleted. Log writes are best-effort: a failed write never
   * fails the send that succeeded.
   */
  readonly sentLog?: SentLog;
}

/** Outcome of attempting to notify a single target. */
export interface SendResult {
  /** The target URL that was notified. */
  readonly target: string;
  /** The discovered endpoint, or `null` when the target declares none. */
  readonly endpoint: string | null;
  /** Whether the endpoint accepted the notification (2xx response). */
  readonly delivered: boolean;
  /** The notification's HTTP status (`0` when not sent or the POST threw). */
  readonly status: number;
}

/**
 * Discover `target`'s Webmention endpoint and notify it that `source` links to
 * it. Targets that declare no endpoint are skipped (`delivered: false`).
 */
export async function sendWebmention(
  source: string,
  target: string,
  options?: SendOptions,
): Promise<SendResult> {
  const doFetch: FetchLike =
    options?.fetch ?? ((input, init) => fetch(input, init));
  const logger = options?.logger ?? noopLogger;
  const metrics = options?.metrics ?? noopMetrics;

  const logOutcome = (result: SendResult): SendResult => {
    const fields = {
      targetHost: hostFromUrl(target),
      endpointHost:
        result.endpoint === null ? undefined : hostFromUrl(result.endpoint),
      delivered: result.delivered,
      status: result.status,
    };
    logger.info(WebmentionLogEvent.SendCompleted, fields);
    // Mirror the log as a counter so "deliveries (by delivered/status)" charts.
    metrics.count(WebmentionLogEvent.SendCompleted, fields);
    return result;
  };

  const endpoint = await discoverEndpoint(target, {
    fetch: doFetch,
    logger,
    metrics,
    fetchAllowedHosts: options?.fetchAllowedHosts,
  });
  // Only notify http(s) endpoints: a page could advertise a `javascript:`,
  // `file:`, or `mailto:` endpoint, which we must never fetch. `URL.protocol`
  // is already lowercased and includes the trailing colon.
  if (endpoint === null) {
    return logOutcome({ target, endpoint: null, delivered: false, status: 0 });
  }
  const protocol = new URL(endpoint).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    return logOutcome({ target, endpoint: null, delivered: false, status: 0 });
  }

  const body = new URLSearchParams({ source, target }).toString();
  let response: Response;
  try {
    // Notify through the SSRF-safe wrapper: the discovered endpoint host (and
    // any redirect hop) is validated against private/loopback ranges and the
    // POST is bounded by a timeout.
    const result = await safeFetch(
      doFetch,
      endpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
      {
        logger,
        logEvent: WebmentionLogEvent.SsrfBlocked,
        allowedHosts: options?.fetchAllowedHosts,
      },
    );
    response = result.response;
  } catch {
    return logOutcome({ target, endpoint, delivered: false, status: 0 });
  }

  const outcome = logOutcome({
    target,
    endpoint,
    delivered: response.ok,
    status: response.status,
  });
  if (outcome.delivered && options?.sentLog) {
    // Best-effort: the notification already succeeded, so a failed log write
    // only costs a future §3.1.5 re-send, never the send itself.
    try {
      await options.sentLog.record(source, target, Date.now());
    } catch {
      logger.warn(WebmentionLogEvent.SentLogWriteFailed, {
        targetHost: hostFromUrl(target),
      });
    }
  }
  return outcome;
}

/**
 * Notify many targets, one {@link SendResult} per target (input order
 * preserved). Failures are reported, never thrown, so one dead target does not
 * sink the rest.
 */
export function sendWebmentions(
  source: string,
  targets: readonly string[],
  options?: SendOptions,
): Promise<SendResult[]> {
  return Promise.all(
    targets.map((target) => sendWebmention(source, target, options)),
  );
}

/** Options for {@link resendForDeletedSource}: a {@link SentLog} is required. */
export interface ResendOptions extends SendOptions {
  /** The log the original sends recorded into — the targets to re-notify. */
  readonly sentLog: SentLog;
}

/**
 * Webmention §3.1.5 (SHOULD): after `source` has been deleted (it now serves
 * `410 Gone`, ideally with a tombstone), re-send a Webmention to every target
 * the sent log recorded for it, so each receiver re-fetches the source, sees
 * it gone, and drops the stored mention.
 *
 * Call this *after* the deletion is live — a receiver that re-verifies against
 * a still-200 source will keep the mention. Log rows are cleared for targets
 * whose re-notification was accepted (or that no longer declare an endpoint —
 * there is nothing left to notify); a target whose endpoint failed keeps its
 * row so a later call can retry. Failures are reported per target, never
 * thrown.
 */
export async function resendForDeletedSource(
  source: string,
  options: ResendOptions,
): Promise<SendResult[]> {
  const { sentLog } = options;
  const logger = options.logger ?? noopLogger;
  const metrics = options.metrics ?? noopMetrics;
  const targets = await sentLog.listTargets(source);
  const results = await Promise.all(
    targets.map(async (target) => {
      // Plain sendWebmention, minus the delivered-notification recording: a
      // re-send tears the log entry down rather than refreshing it.
      const result = await sendWebmention(source, target, {
        ...options,
        sentLog: undefined,
      });
      if (result.delivered || result.endpoint === null) {
        try {
          await sentLog.remove(source, target);
        } catch {
          // Best-effort, like the record path: a kept row only means a
          // harmless duplicate re-send on the next call.
        }
      }
      return result;
    }),
  );
  const fields = {
    targets: results.length,
    delivered: results.filter((r) => r.delivered).length,
  };
  logger.info(WebmentionLogEvent.ResendCompleted, fields);
  metrics.count(WebmentionLogEvent.ResendCompleted, fields);
  return results;
}
