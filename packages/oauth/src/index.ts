/**
 * `@dwk/oauth` — OAuth 2.0 authorization-server building blocks.
 *
 * A cross-standard reusable lib (like `@dwk/dpop`, `@dwk/log`): it provides the
 * shared OAuth 2.0 *server* primitives that `@dwk/indieauth` already partly
 * implements and that the eventual Solid-OIDC OP will need, so they share one
 * audited implementation rather than diverging. It owns the protocol mechanics
 * of four stateful endpoints plus the metadata document and the error registry;
 * it stays **protocol-agnostic** (no IndieWeb/Solid claim handling) and
 * **runtime-agnostic** (plain-data storage seams, Web Fetch + Web Crypto only),
 * so it unit-tests under plain Node without a Workers runtime.
 *
 * What it provides:
 * - **RFC 8414** authorization-server metadata document (config → JSON), the
 *   single source of truth shared with the static document Anglesite publishes.
 * - **RFC 7662** token introspection (protected; derives `active`, maps claims,
 *   surfaces DPoP `cnf.jkt`).
 * - **RFC 7009** token revocation (idempotent, always `200`).
 * - **RFC 9126** pushed authorization requests (single-use `request_uri`,
 *   optional DPoP binding via `@dwk/dpop`).
 * - **RFC 7591** dynamic client registration (strict metadata validation).
 * - A shared, registered **OAuth error registry**.
 *
 * Storage is never owned here: token/client/pushed-request records flow through
 * the plain-data seams in {@link module:store}, which the consuming endpoint
 * package backs with a strongly-consistent store (D1/DO via `@dwk/store`) —
 * never KV.
 *
 * @see spec/packages/oauth.md
 * @packageDocumentation
 */

export { OAuthError, oauthErrorResponse, type OAuthErrorCode } from "./errors";

export {
  buildAuthorizationServerMetadata,
  type AuthorizationServerMetadata,
  type AuthorizationServerMetadataConfig,
} from "./metadata";

export {
  createIntrospectionHandler,
  isTokenActive,
  buildIntrospectionResponse,
  type IntrospectionConfig,
  type IntrospectionResponse,
  type EndpointAuthenticator,
} from "./introspection";

export { createRevocationHandler, type RevocationConfig } from "./revocation";

export {
  createPushedAuthorizationRequestHandler,
  parseRequestUri,
  requestUriFor,
  PUSHED_REQUEST_URI_PREFIX,
  type PushedAuthorizationRequestConfig,
} from "./par";

export {
  createClientRegistrationHandler,
  validateClientMetadata,
  type ClientRegistrationConfig,
} from "./registration";

export type {
  IntrospectionTokenRecord,
  PushedRequestRecord,
  PushedAuthorizationStore,
  ClientRecord,
} from "./store";

export { OAuthLogEvent } from "./log";
export type { ObservabilityConfig } from "./observability";
export type { Logger, Metrics } from "@dwk/log";
