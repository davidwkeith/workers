/**
 * `@dwk/activitypub` — structured observability event taxonomy.
 *
 * An ActivityPub actor verifies HTTP signatures at the edge and federates
 * activities from the Durable Object; a rejected signature or a failed delivery
 * that is silently swallowed is an operational and security blind spot. Logging
 * and metrics are opt-in via an injected {@link Logger}/{@link Metrics} (see
 * `@dwk/log`), wired once at the composition boundary — the stateless front
 * door — and **share this one vocabulary** so a log line and its counter line
 * up.
 *
 * Because the Durable Object cannot receive injected functions across the
 * isolate boundary, it signals its inbound outcomes back to the front door via
 * an internal response header ({@link ApOutcome}); the front door emits the
 * events and strips the header. Alarm-driven delivery outcomes have no HTTP
 * response to hang that header off, so they use two channels: the log line
 * goes straight to `console` (visible in `wrangler tail`), and the matching
 * counter is accumulated durably in the DO's SQLite and drained — as
 * {@link PendingMetric} deltas on the {@link METRICS_HEADER} response header —
 * by the next front-door-forwarded request (which opts in via
 * {@link METRICS_DRAIN_HEADER}); the front door replays the deltas into the
 * injected `Metrics` and strips the header. Counters are delay-tolerant
 * aggregates, so riding the next request instead of firing at the moment of
 * the alarm loses nothing an operator charts. Fields follow the redaction
 * policy — only machine-readable reason codes, activity types, and sanitized
 * hosts; never key material, tokens, or full bodies. See
 * `spec/observability.md`.
 *
 * @packageDocumentation
 */

/** Stable event names emitted by `@dwk/activitypub`. */
export const ActivityPubLogEvent = {
  /** An inbound `POST /inbox` signature failed verification. Field: `reason`. */
  SignatureRejected: "activitypub.signature.rejected",
  /** An inbound `POST /inbox` signature verified. Field: `actorHost`. */
  SignatureAccepted: "activitypub.signature.accepted",
  /** An inbound activity was accepted by the DO. Fields: `activity` (type). */
  InboxAccepted: "activitypub.inbox.accepted",
  /** An inbound activity was a duplicate (deduped by `id`). */
  InboxDuplicate: "activitypub.inbox.duplicate",
  /** A delivery to a remote inbox succeeded. Field: `targetHost`. */
  DeliverySucceeded: "activitypub.delivery.succeeded",
  /** A delivery attempt failed and will be retried or dropped. Fields: `targetHost`, `dropped`. */
  DeliveryFailed: "activitypub.delivery.failed",
  /** A delivery target was refused on SSRF grounds. Field: `reason`. */
  DeliveryBlocked: "activitypub.delivery.blocked",
  /**
   * An owner-authorized request was refused (bad/absent token): a publish, or
   * the owner blocklist read that shares the same token gate.
   */
  PublishRejected: "activitypub.publish.rejected",
  /**
   * A pending counter delta could not be recorded under its own `(event,
   * fields)` key because the DO's pending-metrics table hit its cardinality
   * cap, and was tallied here instead. A non-zero count means delivery
   * counters are being under-attributed (never silently lost). No fields.
   */
  MetricsOverflow: "activitypub.metrics.overflow",
} as const;

/** Union of the event-name string literals in {@link ActivityPubLogEvent}. */
export type ActivityPubLogEvent =
  (typeof ActivityPubLogEvent)[keyof typeof ActivityPubLogEvent];

/**
 * Machine-readable outcome values the DO sets on the internal outcome header so
 * the front door can emit the matching {@link ActivityPubLogEvent}. Internal to
 * the DO↔front-door contract; stripped before the response reaches the client.
 */
export const ApOutcome = {
  InboxAccepted: "inbox_accepted",
  InboxDuplicate: "inbox_duplicate",
} as const;

/** Union of the outcome string literals in {@link ApOutcome}. */
export type ApOutcome = (typeof ApOutcome)[keyof typeof ApOutcome];

/** Internal header the DO uses to report an inbound outcome to the front door. */
export const OUTCOME_HEADER = "x-ap-outcome";
/** Internal header carrying the accepted activity type for logging. */
export const OUTCOME_ACTIVITY_HEADER = "x-ap-outcome-activity";

/**
 * One accumulated counter delta the DO hands back across the isolate boundary:
 * `n` occurrences of `event` with this exact field bag, coalesced since the
 * last drain. The front door replays it as `n` `Metrics.count(event, fields)`
 * calls so per-occurrence data-point semantics (e.g. Analytics Engine's one
 * `writeDataPoint` per count) are preserved.
 */
export interface PendingMetric {
  readonly event: string;
  readonly fields: Record<string, string | number | boolean>;
  readonly n: number;
}

/**
 * Internal request header the front door sets to ask the DO to drain its
 * accumulated counter deltas onto {@link METRICS_HEADER}. Opt-in per request so
 * an internal caller that does not relay the response header (e.g. the MCP tool
 * contributions, which build their own DO requests) never causes deltas to be
 * deleted without ever reaching the injected `Metrics`.
 */
export const METRICS_DRAIN_HEADER = "x-ap-metrics-drain";

/**
 * Internal response header carrying a JSON array of {@link PendingMetric}
 * deltas from the DO to the front door, which replays them into the injected
 * `Metrics` seam and strips the header before the response reaches the client.
 */
export const METRICS_HEADER = "x-ap-metrics";
