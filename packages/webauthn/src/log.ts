/**
 * The structured-logging vocabulary for `@dwk/webauthn`.
 *
 * The Durable Object cannot hold the injected logger/metrics (they do not cross
 * the isolate boundary), so it names its ceremony outcome in a response header
 * ({@link INTERNAL_HEADERS.event}) and the front door emits it on the wired
 * seams. Event names are stable and dotted; callers attach only reason codes and
 * non-sensitive facts — never challenges, signatures, or public keys.
 */

/** Stable, dotted event names emitted on the logger and metrics seams. */
export enum WebAuthnLogEvent {
  /** Registration options issued (a fresh challenge was minted). */
  RegisterOptions = "webauthn.register.options",
  /** A registration ceremony verified and a credential was stored. */
  RegisterVerified = "webauthn.register.verified",
  /** A registration ceremony was rejected. */
  RegisterRejected = "webauthn.register.rejected",
  /** Authentication options issued. */
  AuthenticateOptions = "webauthn.authenticate.options",
  /** An authentication ceremony verified. */
  AuthenticateVerified = "webauthn.authenticate.verified",
  /** An authentication ceremony was rejected. */
  AuthenticateRejected = "webauthn.authenticate.rejected",
  /**
   * Startup warning: no `authorize` hook was supplied, so registration is open
   * unless the composing front door gates `/register/*` upstream. See
   * {@link WebAuthnConfig.authorize}.
   */
  RegistrationUnguarded = "webauthn.config.registration_unguarded",
}
