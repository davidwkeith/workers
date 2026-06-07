/**
 * `@dwk/host-meta` — structured observability event taxonomy.
 *
 * host-meta is public, request-invariant discovery data, so the stakes are low
 * — but which representation clients actually negotiate (XRD vs JRD) is useful
 * signal, and a flood of rejected non-`GET` probes is worth a counter. Logging
 * and metrics are opt-in via an injected {@link Logger}/{@link Metrics} (see
 * `@dwk/log`) and **share this one vocabulary**: the same dotted event name is
 * passed to the logger and the metrics sink so a log line and its counter line
 * up. No request carries user data — the document is host-wide — so fields are
 * limited to the chosen `format` and a machine-readable `reason`.
 *
 * @packageDocumentation
 */

/** Stable event names emitted by `@dwk/host-meta`. */
export const HostMetaLogEvent = {
  /**
   * The host-meta document was served. Field: `format` (`"xrd"` or `"jrd"`),
   * the negotiated representation.
   */
  Served: "host-meta.served",
  /**
   * A request was rejected before the document could be served. Field: `reason`
   * (`method_not_allowed`).
   */
  Rejected: "host-meta.rejected",
} as const;

/** Union of the event-name string literals in {@link HostMetaLogEvent}. */
export type HostMetaLogEvent =
  (typeof HostMetaLogEvent)[keyof typeof HostMetaLogEvent];
