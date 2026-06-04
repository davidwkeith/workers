/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 *
 * One source of truth drives two consumers: the **static** metadata document
 * Anglesite publishes at `/.well-known/oauth-authorization-server` (derived from
 * config at build time), and any **runtime** behaviour that must agree with what
 * was advertised. The builder is pure config→JSON; it is protocol-agnostic, so
 * IndieAuth, a Solid-OIDC OP, or a bare OAuth AS all feed it their own endpoints
 * and supported-value lists.
 *
 * @see https://www.rfc-editor.org/rfc/rfc8414
 */

/** Configuration for {@link buildAuthorizationServerMetadata}. */
export interface AuthorizationServerMetadataConfig {
  /** The authorization-server issuer identifier (a URL, no query/fragment). */
  readonly issuer: string;
  /** Absolute authorization endpoint URL. */
  readonly authorizationEndpoint?: string;
  /** Absolute token endpoint URL. */
  readonly tokenEndpoint?: string;
  /** Absolute token-introspection endpoint URL (RFC 7662). */
  readonly introspectionEndpoint?: string;
  /** Absolute token-revocation endpoint URL (RFC 7009). */
  readonly revocationEndpoint?: string;
  /** Absolute pushed-authorization-request endpoint URL (RFC 9126). */
  readonly pushedAuthorizationRequestEndpoint?: string;
  /** Absolute dynamic-client-registration endpoint URL (RFC 7591). */
  readonly registrationEndpoint?: string;
  /** Absolute JWK Set document URL. */
  readonly jwksUri?: string;
  /** OAuth scopes the server supports. Omitted from the document when empty. */
  readonly scopesSupported?: readonly string[];
  /** Supported `response_type` values. Defaults to `["code"]`. */
  readonly responseTypesSupported?: readonly string[];
  /** Supported `grant_type` values. Defaults to `["authorization_code"]`. */
  readonly grantTypesSupported?: readonly string[];
  /** Supported token-endpoint client authentication methods. Defaults to `["none"]`. */
  readonly tokenEndpointAuthMethodsSupported?: readonly string[];
  /** Supported PKCE `code_challenge` methods. Defaults to `["S256"]`. */
  readonly codeChallengeMethodsSupported?: readonly string[];
  /** Supported DPoP proof signing algorithms (RFC 9449), if DPoP is offered. */
  readonly dpopSigningAlgValuesSupported?: readonly string[];
  /**
   * Whether the AS *requires* PAR for every authorization request (RFC 9126
   * §4). Only emitted (as `true`) when a PAR endpoint is configured.
   */
  readonly requirePushedAuthorizationRequests?: boolean;
}

/**
 * The JSON shape of the authorization-server metadata document. Snake-cased per
 * RFC 8414; optional members are omitted (not `null`) when not configured.
 */
export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint?: string;
  readonly token_endpoint?: string;
  readonly introspection_endpoint?: string;
  readonly revocation_endpoint?: string;
  readonly pushed_authorization_request_endpoint?: string;
  readonly require_pushed_authorization_requests?: boolean;
  readonly registration_endpoint?: string;
  readonly jwks_uri?: string;
  readonly scopes_supported?: readonly string[];
  readonly response_types_supported: readonly string[];
  readonly grant_types_supported: readonly string[];
  readonly token_endpoint_auth_methods_supported: readonly string[];
  readonly code_challenge_methods_supported: readonly string[];
  readonly dpop_signing_alg_values_supported?: readonly string[];
}

/**
 * Build the RFC 8414 metadata document from config. `issuer`,
 * `response_types_supported`, `grant_types_supported`,
 * `token_endpoint_auth_methods_supported`, and `code_challenge_methods_supported`
 * are always present (with defaults); every endpoint URL and the optional value
 * lists are emitted only when supplied, so the document never advertises an
 * endpoint the deployer did not mount.
 */
export function buildAuthorizationServerMetadata(
  config: AuthorizationServerMetadataConfig,
): AuthorizationServerMetadata {
  const metadata: Record<string, unknown> = {
    issuer: config.issuer,
    response_types_supported: config.responseTypesSupported ?? ["code"],
    grant_types_supported: config.grantTypesSupported ?? ["authorization_code"],
    token_endpoint_auth_methods_supported:
      config.tokenEndpointAuthMethodsSupported ?? ["none"],
    code_challenge_methods_supported: config.codeChallengeMethodsSupported ?? [
      "S256",
    ],
  };

  if (config.authorizationEndpoint !== undefined) {
    metadata.authorization_endpoint = config.authorizationEndpoint;
  }
  if (config.tokenEndpoint !== undefined) {
    metadata.token_endpoint = config.tokenEndpoint;
  }
  if (config.introspectionEndpoint !== undefined) {
    metadata.introspection_endpoint = config.introspectionEndpoint;
  }
  if (config.revocationEndpoint !== undefined) {
    metadata.revocation_endpoint = config.revocationEndpoint;
  }
  if (config.pushedAuthorizationRequestEndpoint !== undefined) {
    metadata.pushed_authorization_request_endpoint =
      config.pushedAuthorizationRequestEndpoint;
    // `require_*` is only meaningful alongside the endpoint that satisfies it.
    if (config.requirePushedAuthorizationRequests) {
      metadata.require_pushed_authorization_requests = true;
    }
  }
  if (config.registrationEndpoint !== undefined) {
    metadata.registration_endpoint = config.registrationEndpoint;
  }
  if (config.jwksUri !== undefined) {
    metadata.jwks_uri = config.jwksUri;
  }
  if (config.scopesSupported && config.scopesSupported.length > 0) {
    metadata.scopes_supported = config.scopesSupported;
  }
  if (
    config.dpopSigningAlgValuesSupported &&
    config.dpopSigningAlgValuesSupported.length > 0
  ) {
    metadata.dpop_signing_alg_values_supported =
      config.dpopSigningAlgValuesSupported;
  }

  return metadata as unknown as AuthorizationServerMetadata;
}
