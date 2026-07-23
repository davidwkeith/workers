/**
 * `@dwk/micropub` — structured observability event taxonomy.
 *
 * Micropub consumes DPoP-bound access tokens and mutates the user's site, so an
 * authorization rejection or a validation rejection that is silently swallowed
 * is an operational blind spot. Logging and metrics are opt-in via an injected
 * {@link Logger} and {@link Metrics} (see `@dwk/log`) and **share this one
 * vocabulary**: the same dotted event name is passed to the logger and the
 * metrics sink so a log line and its counter line up. Security-relevant events
 * (an auth rejection by reason) are first-class so being probed with stolen or
 * mis-scoped tokens produces a distinct signal. See `spec/observability.md`.
 *
 * Fields follow the redaction policy: only machine-readable reason codes, the
 * action verb, and scopes — never tokens, post bodies, or media.
 *
 * @packageDocumentation
 */

/** Stable event names emitted by `@dwk/micropub`. */
export const MicropubLogEvent = {
  /**
   * A request failed authorization (missing/invalid token, subject mismatch,
   * DPoP failure, revocation, or insufficient scope). Field: `reason` (the
   * OAuth/Micropub error code), `status`.
   */
  AuthRejected: "micropub.auth.rejected",
  /**
   * A well-formed-but-invalid request was rejected before any mutation (bad
   * body, oversized media, missing `url`, unsupported query/action). Field:
   * `reason`.
   */
  RequestRejected: "micropub.request.rejected",
  /** A create/update/delete/undelete action completed. Field: `action`. */
  ActionCompleted: "micropub.action.completed",
  /** A media upload was streamed to R2. */
  MediaStored: "micropub.media.stored",
  /**
   * A media blob was soft-deleted into the trash prefix
   * (proposed media-endpoint extensions).
   */
  MediaDeleted: "micropub.media.deleted",
  /** A soft-deleted media blob was restored from the trash prefix. */
  MediaUndeleted: "micropub.media.undeleted",
  /**
   * The `micropub_media` metadata insert failed after a successful R2 write
   * while the proposed group is off, so the upload still returned `201` and
   * the blob is unrecorded (it behaves as a legacy blob if the group is later
   * enabled).
   */
  MediaMetadataFailed: "micropub.media.metadata.failed",
} as const;

/** Union of the event-name string literals in {@link MicropubLogEvent}. */
export type MicropubLogEvent =
  (typeof MicropubLogEvent)[keyof typeof MicropubLogEvent];
