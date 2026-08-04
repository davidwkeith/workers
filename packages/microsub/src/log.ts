/**
 * `@dwk/microsub` — structured observability event taxonomy.
 *
 * Microsub consumes DPoP-bound access tokens, mutates the user's reading state,
 * and fetches arbitrary URLs, so an authorization rejection, a validation
 * rejection, or an SSRF block that is silently swallowed is an operational blind
 * spot. Logging and metrics are opt-in via an injected {@link Logger} and
 * {@link Metrics} (see `@dwk/log`) and **share this one vocabulary**: the same
 * dotted event name is passed to the logger and the metrics sink so a log line
 * and its counter line up. See `spec/observability.md`.
 *
 * Fields follow the redaction policy: only machine-readable reason codes, the
 * action verb, scopes, counts, and a sanitized host — never tokens, entry
 * bodies, or full URLs.
 *
 * @packageDocumentation
 */

/** Stable event names emitted by `@dwk/microsub`. */
export const MicrosubLogEvent = {
  /**
   * A request failed authorization (missing/invalid token, subject mismatch,
   * DPoP failure, revocation, or insufficient scope). Fields: `reason` (the
   * OAuth/Microsub error code), `status`.
   */
  AuthRejected: "microsub.auth.rejected",
  /**
   * A well-formed-but-invalid request was rejected before any mutation (unknown
   * action/method, missing `channel`/`url`, bad cursor). Field: `reason`.
   */
  RequestRejected: "microsub.request.rejected",
  /** A channel/follow/timeline action completed. Fields: `action`, `method`. */
  ActionCompleted: "microsub.action.completed",
  /** A scheduled poll enqueued jobs for the followed feeds. Field: `feeds`. */
  PollScheduled: "microsub.poll.scheduled",
  /** A feed poll completed. Fields: `added`, `host`. */
  FeedPolled: "microsub.feed.polled",
  /** A queued poll job threw and is being retried. Fields: `error`, `host`. */
  PollRetry: "microsub.poll.retry",
  /** An outbound fetch was refused on SSRF grounds. Fields: `reason`, `host`. */
  SsrfBlocked: "microsub.ssrf.blocked",
  /**
   * The backgrounded poll-priming queue send for a new follow failed. Not
   * fatal — the next scheduled poll picks up the feed regardless. Field:
   * `message`.
   */
  PollPrimeFailed: "microsub.poll.prime_failed",
} as const;

/** Union of the event-name string literals in {@link MicrosubLogEvent}. */
export type MicrosubLogEvent =
  (typeof MicrosubLogEvent)[keyof typeof MicrosubLogEvent];
