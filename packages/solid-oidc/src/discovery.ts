/**
 * OpenID Connect / Solid-OIDC discovery document + JWKS. The discovery doc
 * extends `@dwk/oauth`'s RFC 8414 authorization-server metadata with the
 * OIDC-required members (subject types, ID-token signing algs, `webid` scope)
 * and the Solid-OIDC `solid_oidc_supported` marker.
 *
 * @packageDocumentation
 */

import { buildAuthorizationServerMetadata } from "@dwk/oauth";

import type { ResolvedSolidOidcConfig } from "./config.js";
import { SIGNING_ALG, type SigningKey } from "./jws.js";

/** Build the `/.well-known/openid-configuration` document. */
export function buildDiscoveryDocument(
  config: ResolvedSolidOidcConfig,
): Record<string, unknown> {
  const base = buildAuthorizationServerMetadata({
    issuer: config.issuer,
    authorizationEndpoint: config.endpoints.authorization,
    tokenEndpoint: config.endpoints.token,
    jwksUri: config.endpoints.jwks,
    scopesSupported: config.scopesSupported,
    responseTypesSupported: ["code"],
    grantTypesSupported: ["authorization_code"],
    tokenEndpointAuthMethodsSupported: ["none"],
    codeChallengeMethodsSupported: ["S256"],
    dpopSigningAlgValuesSupported: ["ES256", "ES384", "RS256", "PS256"],
  });
  return {
    ...base,
    // OIDC-required members RFC 8414 does not carry.
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [SIGNING_ALG],
    response_modes_supported: ["query"],
    claims_supported: ["sub", "webid", "iss", "aud", "exp", "iat", "nonce"],
    // Solid-OIDC marker (the primer's discovery requirement) + DPoP-bound.
    solid_oidc_supported: "https://solidproject.org/TR/solid-oidc",
  };
}

/** Build the JWKS document (public keys only). */
export function buildJwks(key: SigningKey): { keys: unknown[] } {
  return { keys: [key.publicJwk] };
}
