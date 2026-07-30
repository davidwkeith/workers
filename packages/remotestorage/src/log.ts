/**
 * `@dwk/remotestorage` — structured observability event taxonomy.
 *
 * The vault authenticates OAuth bearer tokens and enforces per-module scopes at
 * the edge; an auth/authz decision that is silently swallowed is an operational
 * blind spot. Logging and metrics are opt-in via an injected {@link Logger} and
 * {@link Metrics} (see `@dwk/log`) wired **once at the composition boundary**
 * (the stateless front door). They **share this one vocabulary**: the same
 * dotted event name is passed to the logger and the metrics sink so a log line
 * and its counter line up.
 *
 * Fields follow the redaction policy: only machine-readable reason codes, HTTP
 * method/status, and a sanitized subject host — never tokens, scopes verbatim,
 * resource paths, or bodies. See `spec/observability.md`.
 *
 * @packageDocumentation
 */

/** Stable event names emitted by `@dwk/remotestorage`. */
export const RemoteStorageLogEvent = {
  /** A presented bearer token failed verification. Field: `reason`. */
  AuthRejected: "remotestorage.auth.rejected",
  /** A request authenticated successfully at the edge. Field: `subjectHost`. */
  AuthAccepted: "remotestorage.auth.accepted",
  /** A request lacked the scope (or auth) for the target. Fields: `method`, `status` (401/403). */
  AccessDenied: "remotestorage.scope.denied",
  /** An unexpected error escaped the Durable Object's request handling.
   * Field: `method`. */
  StorageError: "remotestorage.storage.error",
} as const;

/** Union of the event-name string literals in {@link RemoteStorageLogEvent}. */
export type RemoteStorageLogEvent =
  (typeof RemoteStorageLogEvent)[keyof typeof RemoteStorageLogEvent];
