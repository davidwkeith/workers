/**
 * `@dwk/webauthn` — a WebAuthn / passkeys relying party.
 *
 * A stateless Worker front door over a per-relying-party Durable Object that is
 * the consistency authority for short-TTL challenge state and credential
 * records. It runs the four ceremony steps — registration (attestation) and
 * authentication (assertion) options + verification — entirely on Web Crypto,
 * with no external dependency beyond `@dwk/log`.
 *
 * The package is **not** protocol-agnostic: it is the WebAuthn endpoint. It is
 * filed for completeness as an **exploratory, lowest-priority** package — a clean
 * Workers fit, but a step toward generic authentication rather than the
 * web-presence standards this cohort centers on.
 *
 * Attestation is verified for the `none` and `packed` self-attestation formats
 * (the relying party requests `attestation: "none"`); full attestation-chain
 * verification is intentionally out of scope.
 *
 * @see spec/packages/webauthn.md
 * @packageDocumentation
 */

export { createWebAuthn, type WebAuthnHandler } from "./handler";
export { WebAuthnObject } from "./rp";

export {
  type WebAuthnConfig,
  type WebAuthnEnv,
  type UserVerificationRequirement,
} from "./config";

export {
  DEFAULT_COSE_ALGORITHMS,
  COSE_ALG_ES256,
  COSE_ALG_ES384,
  COSE_ALG_RS256,
  COSE_ALG_PS256,
} from "./cose";

export {
  verifyRegistration,
  verifyAuthentication,
  parseClientData,
  parseAuthenticatorData,
  type RegistrationVerifyInput,
  type RegistrationVerifyResult,
  type AuthenticationVerifyInput,
  type AuthenticationVerifyResult,
  type VerifiedCredential,
  type VerifyFailureReason,
} from "./verify";

export { WebAuthnLogEvent } from "./log";
export type { Logger, Metrics } from "@dwk/log";
