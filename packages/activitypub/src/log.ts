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
 * isolate boundary, it signals its inbound/delivery outcomes back to the front
 * door via an internal response header ({@link ApOutcome}); the front door emits
 * the events and strips the header. Fields follow the redaction policy — only
 * machine-readable reason codes, activity types, and sanitized hosts; never key
 * material, tokens, or full bodies. See `spec/observability.md`.
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
  /** An owner publish request was refused (bad/absent token). */
  PublishRejected: "activitypub.publish.rejected",
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
