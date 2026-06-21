/**
 * The IndieAuth Server Metadata document (OAuth 2.0 Authorization Server
 * Metadata, RFC 8414) served from the metadata endpoint. Clients discover it
 * from a `rel="indieauth-metadata"` link and read the authorization/token
 * endpoints and supported PKCE methods from it.
 *
 * @see https://indieauth.spec.indieweb.org/#indieauth-server-metadata
 */

import {
  DPOP_SIGNING_ALG_VALUES_SUPPORTED,
  type ResolvedConfig,
} from "./config.js";
import { SUPPORTED_CODE_CHALLENGE_METHODS } from "./pkce.js";

/** The JSON shape of the metadata document. */
export interface ServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly revocation_endpoint: string;
  readonly revocation_endpoint_auth_methods_supported: readonly string[];
  readonly grant_types_supported: readonly string[];
  readonly response_types_supported: readonly string[];
  readonly code_challenge_methods_supported: readonly string[];
  readonly token_endpoint_auth_methods_supported: readonly string[];
  readonly dpop_signing_alg_values_supported: readonly string[];
  readonly scopes_supported?: readonly string[];
}

/** Build the metadata document from resolved config. */
export function buildServerMetadata(config: ResolvedConfig): ServerMetadata {
  const metadata: ServerMetadata = {
    issuer: config.issuer,
    authorization_endpoint: config.authorizationEndpoint,
    token_endpoint: config.tokenEndpoint,
    revocation_endpoint: config.revocationEndpoint,
    revocation_endpoint_auth_methods_supported: ["none"],
    grant_types_supported: ["authorization_code"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: SUPPORTED_CODE_CHALLENGE_METHODS,
    token_endpoint_auth_methods_supported: ["none"],
    dpop_signing_alg_values_supported: DPOP_SIGNING_ALG_VALUES_SUPPORTED,
  };
  if (config.scopesSupported.length > 0) {
    return { ...metadata, scopes_supported: config.scopesSupported };
  }
  return metadata;
}
