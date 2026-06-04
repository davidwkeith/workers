/**
 * `@dwk/vc` — structured observability event taxonomy.
 *
 * Credential issuance and status changes are the security-relevant moments here:
 * an unauthorized issue attempt, a verification that fails its proof, or a
 * revocation are exactly what an operator wants a signal for. Logging and metrics
 * are opt-in via an injected {@link Logger} and {@link Metrics} (see `@dwk/log`)
 * and **share this one vocabulary**: the same dotted event name is passed to the
 * logger and the metrics sink so a log line and its counter line up.
 *
 * Fields follow the redaction policy: never the credential subject, claims, the
 * signing key, or a `proofValue` — only stable reason codes, a credential `type`
 * count or list, the issuer host, and the status purpose/outcome.
 *
 * @packageDocumentation
 */

/** Stable event names emitted by `@dwk/vc`. */
export const VcLogEvent = {
  /** A credential was issued (signed). Fields: `cryptosuite`. */
  Issued: "vc.issued",
  /** A credential was verified. Fields: `verified` (boolean). */
  Verified: "vc.verified",
  /** A credential's status was changed. Fields: `statusPurpose`, `value`. */
  StatusChanged: "vc.status.changed",
  /**
   * A request was rejected before completing. Field: `reason`
   * (`method_not_allowed`, `unauthorized`, `malformed_request`,
   * `unsupported`, `status_disabled`, `not_found`).
   */
  Rejected: "vc.rejected",
} as const;

/** Union of the event-name string literals in {@link VcLogEvent}. */
export type VcLogEvent = (typeof VcLogEvent)[keyof typeof VcLogEvent];
