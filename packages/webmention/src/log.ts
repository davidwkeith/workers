/**
 * `@dwk/webmention` — structured log event taxonomy.
 *
 * The package's logging is opt-in via an injected {@link Logger} (see
 * `@dwk/log`). Event names are stable, dotted, and queryable — operators filter
 * on these rather than grepping free text. Security-relevant events (a blocked
 * SSRF attempt, a receiver rejection, a poison-message retry) are first-class
 * here so that being actively probed produces a distinct signal instead of
 * looking like a dead link. See `spec/observability.md`.
 *
 * @packageDocumentation
 */

/**
 * Stable event names emitted by `@dwk/webmention`. Fields logged alongside each
 * event use `hostFromUrl` for any URL so an attacker-supplied path/query is
 * never recorded; tokens and bodies are never logged.
 */
export const WebmentionLogEvent = {
  /**
   * An outbound fetch was refused on SSRF grounds. Fields: `reason`
   * (machine-readable cause), `host` (sanitized, when known).
   */
  SsrfBlocked: "webmention.ssrf.blocked",
  /** A received mention passed validation and was enqueued. */
  ReceiveAccepted: "webmention.receive.accepted",
  /** A received mention was rejected at validation. Field: `reason`. */
  ReceiveRejected: "webmention.receive.rejected",
  /** Source verification finished. Fields: `links`, `status`. */
  VerifyCompleted: "webmention.verify.completed",
  /** The source fetch failed/was blocked during verification. Field: `error`. */
  VerifyFetchFailed: "webmention.verify.fetch_failed",
  /** A queue message threw and is being retried. Field: `error`. */
  QueueRetry: "webmention.queue.retry",
  /** A send attempt finished. Fields: `endpointHost`, `delivered`, `status`. */
  SendCompleted: "webmention.send.completed",
} as const;

/** Union of the event-name string literals in {@link WebmentionLogEvent}. */
export type WebmentionLogEvent =
  (typeof WebmentionLogEvent)[keyof typeof WebmentionLogEvent];
