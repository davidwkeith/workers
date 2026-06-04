/**
 * `@dwk/indieauth` — structured observability event taxonomy.
 *
 * IndieAuth is the identity layer: an auth/authz rejection that is silently
 * swallowed is an operational blind spot (an operator being probed with forged
 * codes or stolen DPoP proofs would never know). Logging and metrics are opt-in
 * via an injected {@link Logger} and {@link Metrics} (see `@dwk/log`) and **share
 * this one vocabulary**: the same dotted event name is passed to the logger and
 * the metrics sink so a log line and its counter line up. Security-relevant
 * events (an authorization rejection, a token-endpoint rejection) are
 * first-class so being actively probed produces a distinct signal. See
 * `spec/observability.md`.
 *
 * Fields logged alongside each event follow the redaction policy: a `client_id`
 * is reduced to its host via `hostFromUrl`, and authorization codes, code
 * verifiers, access tokens, and signing keys are **never** logged — only
 * machine-readable reason codes, hosts, and scopes.
 *
 * @packageDocumentation
 */

/** Stable event names emitted by `@dwk/indieauth`. */
export const IndieAuthLogEvent = {
  /**
   * An authorization request was rejected before a code could be issued. Fields:
   * `reason` (machine-readable cause), `clientHost` (sanitized, when known).
   */
  AuthorizeRejected: "indieauth.authorize.rejected",
  /** An authorization code was issued and the client redirected. Field: `clientHost`. */
  AuthorizeApproved: "indieauth.authorize.approved",
  /** A DPoP-bound access token was minted. Fields: `clientHost`, `scope`. */
  TokenIssued: "indieauth.token.issued",
  /**
   * A token-endpoint (or profile-exchange) request was rejected. Field: `reason`
   * (e.g. `invalid_grant`, `pkce_failed`, `dpop_invalid`).
   */
  TokenRejected: "indieauth.token.rejected",
  /** A token was revoked at the revocation endpoint. */
  TokenRevoked: "indieauth.token.revoked",
} as const;

/** Union of the event-name string literals in {@link IndieAuthLogEvent}. */
export type IndieAuthLogEvent =
  (typeof IndieAuthLogEvent)[keyof typeof IndieAuthLogEvent];
