/**
 * `@dwk/webfinger` — structured observability event taxonomy.
 *
 * WebFinger is public discovery data, so the stakes are lower than an auth
 * endpoint — but a server being scraped for `acct:` handles it does not control,
 * or a misconfigured resource map that 404s every lookup, is exactly the kind of
 * thing an operator wants a signal for. Logging and metrics are opt-in via an
 * injected {@link Logger} and {@link Metrics} (see `@dwk/log`) and **share this
 * one vocabulary**: the same dotted event name is passed to the logger and the
 * metrics sink so a log line and its counter line up.
 *
 * Fields follow the redaction policy: a `resource` is reduced to its **host**
 * (the domain of an `acct:`/`mailto:` handle or an `https:` URI) via the
 * handler's `resourceHost` helper — the local part (the user identifier) is
 * never logged, only the domain, a machine-readable `reason`, and the count of
 * `rel` filters. See `spec/observability.md`.
 *
 * @packageDocumentation
 */

/** Stable event names emitted by `@dwk/webfinger`. */
export const WebfingerLogEvent = {
  /**
   * A `resource` was matched and a JRD returned. Fields: `resourceHost`
   * (sanitized), `relCount` (number of `rel` filters applied).
   */
  Resolved: "webfinger.resolved",
  /**
   * A request was rejected before a JRD could be returned. Field: `reason`
   * (`missing_resource`, `malformed_resource`, `not_found`, or
   * `method_not_allowed`), plus `resourceHost` when a `resource` was supplied.
   */
  Rejected: "webfinger.rejected",
} as const;

/** Union of the event-name string literals in {@link WebfingerLogEvent}. */
export type WebfingerLogEvent =
  (typeof WebfingerLogEvent)[keyof typeof WebfingerLogEvent];
