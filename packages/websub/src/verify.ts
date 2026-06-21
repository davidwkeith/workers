/**
 * `@dwk/websub` — verification of intent.
 *
 * Before a hub acts on a subscribe/unsubscribe request it confirms the request
 * was genuinely intended by the owner of the callback URL (WebSub §5.3): it
 * issues a `GET` to the callback carrying a random `hub.challenge`, and the
 * subscriber confirms by echoing that exact challenge back in a `2xx` response
 * body. This stops an attacker from signing up (or tearing down) a third party's
 * callback. The GET goes through {@link safeFetch} so a callback can't point the
 * hub at its own network. See `spec/packages/websub.md`.
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
import type { FetchLike } from "./fetch.js";
import { readBytesCapped } from "./fetch.js";
import { WebSubLogEvent } from "./log.js";
import { safeFetch } from "./safe-fetch.js";

/** Bytes of randomness in a generated challenge (hex-encoded → twice as many chars). */
const CHALLENGE_BYTES = 24;
/** A confirming challenge echo is tiny; refuse to buffer more than this. */
const MAX_CHALLENGE_ECHO_BYTES = 8 * 1024;

/** Inputs to {@link verifyIntent}. */
export interface VerifyIntentOptions {
  readonly mode: "subscribe" | "unsubscribe";
  /** Lease (seconds) advertised in the challenge; included only for subscribe. */
  readonly leaseSeconds?: number;
  /** `fetch` implementation; defaults to global `fetch`. */
  readonly fetch?: FetchLike;
  /** Challenge string to send; defaults to a fresh random value (override in tests). */
  readonly challenge?: string;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
}

/** Outcome of a verification-of-intent exchange. */
export interface VerifyIntentResult {
  /** True when the callback echoed the exact challenge with a 2xx status. */
  readonly confirmed: boolean;
  /** The callback's HTTP status (`0` when the GET threw or was blocked). */
  readonly status: number;
}

/** Generate a fresh, unguessable challenge value. */
export function generateChallenge(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the verification callback URL, appending the `hub.*` query parameters to
 * whatever the subscriber's callback already carries (WebSub §5.3). `hub.mode`
 * and `hub.topic` echo the request; `hub.challenge` is the value the subscriber
 * must return; `hub.lease_seconds` is included for a subscribe.
 */
export function buildVerificationUrl(
  callback: string,
  params: {
    mode: "subscribe" | "unsubscribe";
    topic: string;
    challenge: string;
    leaseSeconds?: number;
  },
): string {
  const url = new URL(callback);
  url.searchParams.append("hub.mode", params.mode);
  url.searchParams.append("hub.topic", params.topic);
  url.searchParams.append("hub.challenge", params.challenge);
  if (params.mode === "subscribe" && params.leaseSeconds !== undefined) {
    url.searchParams.append("hub.lease_seconds", String(params.leaseSeconds));
  }
  return url.toString();
}

/**
 * Verify a subscriber's intent for `callback` / `topic`.
 *
 * Issues the challenge GET through {@link safeFetch} and confirms the response is
 * `2xx` with a body whose trimmed text equals the challenge. Any throw (network,
 * timeout, SSRF block) is treated as "not confirmed" with status `0` — the
 * caller does not distinguish a hostile callback from an unreachable one.
 */
export async function verifyIntent(
  callback: string,
  topic: string,
  options: VerifyIntentOptions,
): Promise<VerifyIntentResult> {
  const doFetch: FetchLike =
    options.fetch ?? ((input, init) => fetch(input, init));
  const logger = options.logger ?? noopLogger;
  const metrics = options.metrics ?? noopMetrics;
  const challenge = options.challenge ?? generateChallenge();

  const url = buildVerificationUrl(callback, {
    mode: options.mode,
    topic,
    challenge,
    leaseSeconds: options.leaseSeconds,
  });

  const finish = (confirmed: boolean, status: number): VerifyIntentResult => {
    const fields = {
      mode: options.mode,
      callbackHost: hostFromUrl(callback),
      confirmed,
      status,
    };
    logger.info(WebSubLogEvent.VerifyCompleted, fields);
    metrics.count(WebSubLogEvent.VerifyCompleted, fields);
    return { confirmed, status };
  };

  let response: Response;
  try {
    const result = await safeFetch(
      doFetch,
      url,
      { method: "GET" },
      { logger, metrics },
    );
    response = result.response;
  } catch (err) {
    const fields = {
      callbackHost: hostFromUrl(callback),
      error: err instanceof Error ? err.name : "unknown",
    };
    logger.warn(WebSubLogEvent.VerifyFetchFailed, fields);
    metrics.count(WebSubLogEvent.VerifyFetchFailed, fields);
    return finish(false, 0);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return finish(false, response.status);
  }

  const bytes = await readBytesCapped(response, MAX_CHALLENGE_ECHO_BYTES);
  if (bytes === null) {
    return finish(false, response.status);
  }
  const echoed = new TextDecoder().decode(bytes).trim();
  return finish(echoed === challenge, response.status);
}

/** Inputs to {@link notifyDenial}. */
export interface NotifyDenialOptions {
  /** Machine-readable cause echoed to the subscriber as `hub.reason` (optional). */
  readonly reason?: string;
  /** `fetch` implementation; defaults to global `fetch`. */
  readonly fetch?: FetchLike;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
}

/**
 * Build the subscription-denial notification URL (WebSub §5.2): the subscriber's
 * callback with `hub.mode=denied` and `hub.topic` appended, plus an optional
 * `hub.reason`, preserving any query string the callback already carries.
 */
export function buildDenialUrl(
  callback: string,
  params: { topic: string; reason?: string },
): string {
  const url = new URL(callback);
  url.searchParams.append("hub.mode", "denied");
  url.searchParams.append("hub.topic", params.topic);
  if (params.reason !== undefined && params.reason !== "") {
    url.searchParams.append("hub.reason", params.reason);
  }
  return url.toString();
}

/**
 * Tell a subscriber its subscription was denied (WebSub §5.2): issue a
 * best-effort `GET` to the callback with `hub.mode=denied`. Never throws — a
 * denial that cannot be delivered (unreachable callback, SSRF block) is logged,
 * not retried, since the subscription was never created either way. The GET goes
 * through {@link safeFetch} so a hostile callback can't point the hub at its own
 * network.
 */
export async function notifyDenial(
  callback: string,
  topic: string,
  options?: NotifyDenialOptions,
): Promise<void> {
  const doFetch: FetchLike =
    options?.fetch ?? ((input, init) => fetch(input, init));
  const logger = options?.logger ?? noopLogger;
  const metrics = options?.metrics ?? noopMetrics;

  const url = buildDenialUrl(callback, { topic, reason: options?.reason });

  // The denial *decision* stands regardless of whether the subscriber's callback
  // can be reached, so the event is always emitted — silently swallowing it when
  // the GET is blocked (e.g. an SSRF-blocked callback) would hide exactly the
  // probing we want a signal for. `notified` records whether the callback
  // actually accepted the GET, so a failed delivery is visible, not faked.
  let notified = false;
  try {
    const result = await safeFetch(
      doFetch,
      url,
      { method: "GET" },
      { logger, metrics },
    );
    notified = result.response.ok;
    await result.response.body?.cancel().catch(() => undefined);
  } catch {
    // Best-effort: the subscription row was never created, so a failed denial
    // notification leaves no inconsistent state to repair.
  }
  const fields = {
    callbackHost: hostFromUrl(callback),
    topicHost: hostFromUrl(topic),
    notified,
    ...(options?.reason !== undefined ? { reason: options.reason } : {}),
  };
  logger.info(WebSubLogEvent.SubscriptionDenied, fields);
  metrics.count(WebSubLogEvent.SubscriptionDenied, fields);
}
