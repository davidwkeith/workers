/**
 * `@dwk/websub` — structured observability event taxonomy.
 *
 * Like the rest of the cohort, this package's logging and metrics are opt-in via
 * an injected {@link Logger} and {@link Metrics} (see `@dwk/log`) and **share one
 * vocabulary**: the same dotted event name is passed to `logger.*(...)` and
 * `metrics.count(...)` so a log line and its counter line up. Event names are
 * stable, dotted, and queryable. Security-relevant events (a blocked SSRF
 * attempt, a verification rejection) are first-class so being actively probed
 * produces a distinct signal rather than silence. See `spec/observability.md`.
 *
 * @packageDocumentation
 */

/**
 * Stable event names emitted by `@dwk/websub`. Fields logged alongside each
 * event use `hostFromUrl` for any URL so an attacker-supplied path/query is
 * never recorded; secrets and bodies are never logged.
 */
export const WebSubLogEvent = {
  /**
   * An outbound fetch was refused on SSRF grounds. Fields: `reason`
   * (machine-readable cause), `host` (sanitized, when known).
   */
  SsrfBlocked: "websub.ssrf.blocked",
  /** A subscribe/unsubscribe request passed validation and was enqueued. Fields: `mode`, `callbackHost`, `topicHost`. */
  RequestAccepted: "websub.request.accepted",
  /** A subscribe/unsubscribe request was rejected at validation. Field: `reason`. */
  RequestRejected: "websub.request.rejected",
  /** A publish ping passed validation and distribution was enqueued. Field: `topicHost`. */
  PublishAccepted: "websub.publish.accepted",
  /** A publish ping was rejected at validation. Field: `reason`. */
  PublishRejected: "websub.publish.rejected",
  /** Intent verification of a callback completed. Fields: `mode`, `callbackHost`, `confirmed`, `status`. */
  VerifyCompleted: "websub.verify.completed",
  /** The verification GET to the callback failed/was blocked. Field: `error`. */
  VerifyFetchFailed: "websub.verify.fetch_failed",
  /** A subscription was activated (verified subscribe). Fields: `callbackHost`, `topicHost`, `leaseSeconds`. */
  SubscriptionActivated: "websub.subscription.activated",
  /** A subscription was removed (verified unsubscribe or pruned). Fields: `callbackHost`, `topicHost`, `reason`. */
  SubscriptionRemoved: "websub.subscription.removed",
  /** A content-distribution delivery to one subscriber finished. Fields: `callbackHost`, `delivered`, `status`. */
  DeliveryCompleted: "websub.delivery.completed",
  /** A distribution job could not fetch the topic content. Fields: `topicHost`, `status`. */
  TopicFetchFailed: "websub.topic.fetch_failed",
  /** A queue message threw and is being retried. Fields: `kind`, `error`. */
  QueueRetry: "websub.queue.retry",
} as const;

/** Union of the event-name string literals in {@link WebSubLogEvent}. */
export type WebSubLogEvent =
  (typeof WebSubLogEvent)[keyof typeof WebSubLogEvent];
