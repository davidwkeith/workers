/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata — the discovery document an
 * MCP client fetches after a `401` to learn which authorization server(s) can
 * mint it a token for this resource. Per spec/packages/mcp.md, this package
 * never serves the document itself: the well-known URI it lives at
 * (`/.well-known/oauth-protected-resource/mcp`, derived from the resource
 * identifier) sits outside this handler's mount, so the composing Worker's
 * root router serves it. This module only builds the plain-data JSON body —
 * the resource-server counterpart to `@dwk/oauth`'s RFC 8414 `metadata.ts`.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9728
 */

export interface ProtectedResourceMetadataConfig {
  /** The protected resource's identifier — the MCP endpoint's canonical URL. */
  readonly resource: string;
  /** Issuer identifier(s) of the authorization server(s) that can mint tokens for this resource. */
  readonly authorizationServers: readonly string[];
  /** Scope values this resource's tools may require, for client discovery. */
  readonly scopesSupported?: readonly string[];
  /** A human-readable documentation URL for this resource. */
  readonly resourceDocumentation?: string;
}

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly bearer_methods_supported: readonly string[];
  readonly scopes_supported?: readonly string[];
  readonly resource_documentation?: string;
}

/**
 * Build the RFC 9728 metadata document. `bearer_methods_supported` is always
 * `["DPoP"]`: this lib never accepts a plain bearer token
 * (spec/non-functional-requirements.md "DPoP everywhere").
 */
export function buildProtectedResourceMetadata(
  config: ProtectedResourceMetadataConfig,
): ProtectedResourceMetadata {
  return {
    resource: config.resource,
    authorization_servers: config.authorizationServers,
    bearer_methods_supported: ["DPoP"],
    ...(config.scopesSupported
      ? { scopes_supported: config.scopesSupported }
      : {}),
    ...(config.resourceDocumentation
      ? { resource_documentation: config.resourceDocumentation }
      : {}),
  };
}
