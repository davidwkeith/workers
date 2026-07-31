/**
 * `@dwk/solid-oidc` — a Solid-OIDC OpenID Provider.
 *
 * Endpoint package. Issues DPoP-bound, ES256-signed access tokens carrying a
 * `webid` claim (plus OIDC ID tokens) through an authorization-code + PKCE
 * (S256) flow, so a Solid pod on the owner's own domain can accept tokens from
 * a provider the owner runs — closing `spec/open-questions.md` §1's "when do we
 * own the OpenID Provider" gap toward a **separate package** that composes
 * `@dwk/oauth`'s primitives rather than living inside `@dwk/indieauth`.
 *
 * The access-token claim set is dictated by what `@dwk/solid-pod` validates
 * (`iss`, `webid`, `aud` ⊇ the pod's set, `cnf.jkt`, `typ: at+jwt`), so tokens
 * this OP mints are accepted by pods configured to trust its JWKS.
 *
 * Owner authentication + consent is the injected `approveAuthorization` hook
 * (the IndieAuth pattern), keeping identity/UI out of the library.
 *
 * @see spec/packages/solid-oidc.md
 * @packageDocumentation
 */

export { createSolidOidc, type SolidOidcHandler } from "./handler.js";
export {
  type SolidOidcConfig,
  type SolidOidcEnv,
  type SolidOidcApproval,
  type SolidOidcAuthorizationRequest,
  type ApproveSolidOidcAuthorization,
} from "./config.js";
export {
  importSigningKey,
  generateSigningJwk,
  SIGNING_ALG,
  type SigningKey,
  type Jwk,
} from "./jws.js";
export { buildDiscoveryDocument, buildJwks } from "./discovery.js";
export {
  mintAccessToken,
  mintIdToken,
  type AccessTokenInput,
  type IdTokenInput,
} from "./token.js";
export { verifyPkce, isValidChallenge } from "./pkce.js";
export { SolidOidcLogEvent } from "./log.js";
export {
  createCodeStore,
  type CodeStore,
  type AuthorizationCodeRecord,
} from "./store.js";
