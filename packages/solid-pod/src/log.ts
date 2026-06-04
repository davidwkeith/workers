/**
 * `@dwk/solid-pod` — structured observability event taxonomy.
 *
 * A Solid Pod authenticates DPoP-bound tokens at the edge and enforces WAC in
 * the Durable Object; an auth/authz decision that is silently swallowed is an
 * operational blind spot. Logging and metrics are opt-in via an injected
 * {@link Logger} and {@link Metrics} (see `@dwk/log`) wired **once at the
 * composition boundary** — the stateless front door. They **share this one
 * vocabulary**: the same dotted event name is passed to the logger and the
 * metrics sink so a log line and its counter line up.
 *
 * Because the Durable Object cannot receive injected functions across the
 * isolate boundary, it signals its authorization outcomes back to the front door
 * via an internal response header ({@link INTERNAL_HEADERS.outcome}); the front
 * door — which holds the injected seams — emits the events and strips the header.
 * This keeps the DO free of any logger and honors the composition contract.
 *
 * Fields follow the redaction policy: only machine-readable reason codes, HTTP
 * method/status, and a sanitized agent host (`hostFromUrl`) — never tokens,
 * proofs, resource paths, or bodies. See `spec/observability.md`.
 *
 * @packageDocumentation
 */

/** Stable event names emitted by `@dwk/solid-pod`. */
export const SolidPodLogEvent = {
  /**
   * A presented credential failed edge authentication. Field: `reason` (an
   * {@link AuthFailureReason}, e.g. `signature_invalid`, `dpop_invalid`).
   */
  AuthRejected: "solid.auth.rejected",
  /** A request authenticated successfully at the edge. Field: `agentHost`. */
  AuthAccepted: "solid.auth.accepted",
  /** WAC refused the request in the Durable Object. Fields: `method`, `status` (401/403). */
  AccessDenied: "solid.wac.denied",
  /** A proof-less write was refused (DPoP required). Field: `method`. */
  AnonymousWriteRefused: "solid.write.anonymous_refused",
  /** A write's DPoP `jti` was replayed and the write was refused. Field: `method`. */
  ReplayRejected: "solid.dpop.replay_rejected",
} as const;

/** Union of the event-name string literals in {@link SolidPodLogEvent}. */
export type SolidPodLogEvent =
  (typeof SolidPodLogEvent)[keyof typeof SolidPodLogEvent];

/**
 * Machine-readable outcome values the Durable Object sets on
 * {@link INTERNAL_HEADERS.outcome} so the front door can emit the matching
 * {@link SolidPodLogEvent}. Internal to the DO↔front-door contract; stripped
 * before the response reaches the client.
 */
export const PodOutcome = {
  WacDenied: "wac_denied",
  AnonymousWriteRefused: "anon_write_refused",
  Replay: "replay",
} as const;

/** Union of the outcome string literals in {@link PodOutcome}. */
export type PodOutcome = (typeof PodOutcome)[keyof typeof PodOutcome];
