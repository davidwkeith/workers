/**
 * `@dwk/webmention` — sender.
 *
 * On publish, notify each outbound target: discover its Webmention endpoint
 * (see {@link discoverEndpoint}) and POST a `source`/`target` notification as
 * `application/x-www-form-urlencoded`. See `spec/packages/webmention.md`.
 *
 * @packageDocumentation
 */

import { discoverEndpoint } from "./discovery";
import type { FetchLike } from "./fetch";
import { safeFetch } from "./safe-fetch";

/** Options for {@link sendWebmention} / {@link sendWebmentions}. */
export interface SendOptions {
  /** `fetch` implementation to use; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
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

  const endpoint = await discoverEndpoint(target, { fetch: doFetch });
  // Only notify http(s) endpoints: a page could advertise a `javascript:`,
  // `file:`, or `mailto:` endpoint, which we must never fetch.
  if (endpoint === null || !/^https?:$/i.test(new URL(endpoint).protocol)) {
    return { target, endpoint: null, delivered: false, status: 0 };
  }

  const body = new URLSearchParams({ source, target }).toString();
  let response: Response;
  try {
    // Notify through the SSRF-safe wrapper: the discovered endpoint host (and
    // any redirect hop) is validated against private/loopback ranges and the
    // POST is bounded by a timeout.
    const result = await safeFetch(doFetch, endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    response = result.response;
  } catch {
    return { target, endpoint, delivered: false, status: 0 };
  }

  return {
    target,
    endpoint,
    delivered: response.ok,
    status: response.status,
  };
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
