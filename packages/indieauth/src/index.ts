/**
 * `@dwk/indieauth` — IndieAuth authorization, token, and metadata endpoints.
 *
 * Endpoint package: exports a factory returning a `fetch`-compatible handler,
 * mountable under a path prefix so it composes with other `@dwk` packages in
 * one Worker. It is the identity layer rooted at the user's domain — it runs
 * the authorization-code + PKCE flow, issues DPoP-bound access tokens (bound via
 * `@dwk/dpop`'s `cnf.jkt`), and publishes an OAuth 2.0 / IndieAuth server
 * metadata document so clients can discover the endpoints and PKCE methods.
 *
 * Authoritative authorization state (codes, issued tokens) lives in D1, a
 * strongly-consistent store — never KV. Authentication and consent are
 * delegated to the deployer via {@link IndieAuthConfig.approveAuthorization},
 * since identity and UI are not a library concern.
 *
 * @see spec/packages/indieauth.md
 * @packageDocumentation
 */

export { createIndieAuth } from "./handler.js";
export type { IndieAuthEnv, IndieAuthHandler } from "./handler.js";

export type {
  IndieAuthConfig,
  AuthorizationRequest,
  AuthorizationApproval,
  ApproveAuthorization,
  RedirectUriPolicy,
  ResourceIndicatorPolicy,
  ProfileInfo,
} from "./config.js";

export {
  verifyAccessToken,
  signAccessToken,
  accessTokenHash,
  type AccessTokenClaims,
  type Confirmation,
  type VerifyAccessTokenResult,
  type VerifyAccessTokenOptions,
  type AccessTokenFailureReason,
} from "./token.js";

export {
  createIndieAuthStore,
  type IndieAuthStore,
  type IndieAuthStoreEnv,
  type AuthorizationCodeRecord,
  type IssuedTokenRecord,
} from "./store.js";

export {
  verifyPkce,
  isSupportedChallengeMethod,
  SUPPORTED_CODE_CHALLENGE_METHODS,
  type CodeChallengeMethod,
} from "./pkce.js";

export {
  canonicalizeProfileUrl,
  parseRelMeLinks,
  relMeLinksBack,
} from "./profile.js";

export { buildServerMetadata, type ServerMetadata } from "./metadata.js";

export { IndieAuthLogEvent } from "./log.js";
export type { Logger, Metrics } from "@dwk/log";
