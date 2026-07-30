/**
 * The structured-logging vocabulary for `@dwk/solid-oidc`.
 *
 * Only security-relevant rejections are logged (a request that never reaches
 * a state worth alerting on stays silent) — a rejected DPoP proof, an
 * invalid/replayed/expired code, or a failed PKCE verification.
 */

/** Stable, dotted event names emitted on the logger and metrics seams. */
export enum SolidOidcLogEvent {
  /** The token endpoint rejected a request's DPoP proof (missing or invalid). */
  DpopRejected = "solid_oidc.token.dpop_rejected",
  /** The token endpoint rejected an unknown, already-used, or expired code,
   * or a code/redirect_uri/client_id mismatch. */
  InvalidGrant = "solid_oidc.token.invalid_grant",
  /** The token endpoint rejected a PKCE verifier that didn't match the
   * stored challenge. */
  PkceMismatch = "solid_oidc.token.pkce_mismatch",
}
