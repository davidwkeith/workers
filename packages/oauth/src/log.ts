/**
 * `@dwk/oauth` — structured observability event taxonomy.
 *
 * These endpoints sit on the security-sensitive edge of an authorization server:
 * a refused introspection (token scanning), a rejected registration, or a
 * consumed/forged `request_uri` is exactly the kind of event an operator needs a
 * signal for. Logging and metrics are opt-in via an injected {@link Logger} and
 * {@link Metrics} (see `@dwk/log`) and **share this one vocabulary** — the same
 * dotted event name is passed to the logger and the metrics sink so a log line
 * and its counter line up.
 *
 * Fields follow the redaction policy: a `client_id` URL is reduced to its host
 * via `hostFromUrl`, and tokens, secrets, codes, and `request_uri` reference
 * values are **never** logged — only machine-readable reason codes, hosts, and
 * scopes.
 *
 * @packageDocumentation
 */

/** Stable event names emitted by `@dwk/oauth`. */
export const OAuthLogEvent = {
  /** A token was introspected and reported active. */
  IntrospectionActive: "oauth.introspection.active",
  /** A token was introspected and reported inactive (unknown/expired/revoked). */
  IntrospectionInactive: "oauth.introspection.inactive",
  /** An introspection request was refused (failed endpoint authentication). */
  IntrospectionRejected: "oauth.introspection.rejected",
  /** A token was revoked (or the no-op revocation of an unknown token). */
  TokenRevoked: "oauth.revocation.revoked",
  /** A revocation request was refused (failed endpoint authentication). */
  RevocationRejected: "oauth.revocation.rejected",
  /** A pushed authorization request was stored and a `request_uri` issued. */
  PushedRequestStored: "oauth.par.stored",
  /** A pushed authorization request was rejected before storage. Field: `reason`. */
  PushedRequestRejected: "oauth.par.rejected",
  /** A dynamic client registration succeeded. Field: `clientHost`. */
  ClientRegistered: "oauth.registration.registered",
  /** A dynamic client registration was rejected. Field: `reason`. */
  ClientRegistrationRejected: "oauth.registration.rejected",
} as const;

/** Union of the event-name string literals in {@link OAuthLogEvent}. */
export type OAuthLogEvent = (typeof OAuthLogEvent)[keyof typeof OAuthLogEvent];
