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

  return logOutcome({
    target,
    endpoint,
    delivered: response.ok,
    status: response.status,
  });
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
