import { describe, expect, it } from "vitest";

import { buildAuthorizationServerMetadata } from "./metadata";

describe("buildAuthorizationServerMetadata", () => {
  it("always emits issuer and the defaulted supported-value lists", () => {
    const metadata = buildAuthorizationServerMetadata({
      issuer: "https://example.com",
    });
    expect(metadata).toEqual({
      issuer: "https://example.com",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("emits each endpoint URL only when configured", () => {
    const metadata = buildAuthorizationServerMetadata({
      issuer: "https://example.com",
      authorizationEndpoint: "https://example.com/authorize",
      tokenEndpoint: "https://example.com/token",
      introspectionEndpoint: "https://example.com/introspect",
      revocationEndpoint: "https://example.com/revoke",
      pushedAuthorizationRequestEndpoint: "https://example.com/par",
      registrationEndpoint: "https://example.com/register",
      jwksUri: "https://example.com/jwks",
    });
    expect(metadata.authorization_endpoint).toBe(
      "https://example.com/authorize",
    );
    expect(metadata.token_endpoint).toBe("https://example.com/token");
    expect(metadata.introspection_endpoint).toBe(
      "https://example.com/introspect",
    );
    expect(metadata.revocation_endpoint).toBe("https://example.com/revoke");
    expect(metadata.pushed_authorization_request_endpoint).toBe(
      "https://example.com/par",
    );
    expect(metadata.registration_endpoint).toBe("https://example.com/register");
    expect(metadata.jwks_uri).toBe("https://example.com/jwks");
  });

  it("omits unset endpoints entirely (not null)", () => {
    const metadata = buildAuthorizationServerMetadata({
      issuer: "https://example.com",
    });
    expect("token_endpoint" in metadata).toBe(false);
    expect("registration_endpoint" in metadata).toBe(false);
    expect("scopes_supported" in metadata).toBe(false);
    expect("dpop_signing_alg_values_supported" in metadata).toBe(false);
  });

  it("emits require_pushed_authorization_requests only with a PAR endpoint", () => {
    const withEndpoint = buildAuthorizationServerMetadata({
      issuer: "https://example.com",
      pushedAuthorizationRequestEndpoint: "https://example.com/par",
      requirePushedAuthorizationRequests: true,
    });
    expect(withEndpoint.require_pushed_authorization_requests).toBe(true);

    // The flag is meaningless without the endpoint, so it is dropped.
    const withoutEndpoint = buildAuthorizationServerMetadata({
      issuer: "https://example.com",
      requirePushedAuthorizationRequests: true,
    });
    expect("require_pushed_authorization_requests" in withoutEndpoint).toBe(
      false,
    );
  });

  it("emits scopes_supported only when non-empty", () => {
    expect(
      "scopes_supported" in
        buildAuthorizationServerMetadata({
          issuer: "https://example.com",
          scopesSupported: [],
        }),
    ).toBe(false);
    expect(
      buildAuthorizationServerMetadata({
        issuer: "https://example.com",
        scopesSupported: ["read", "write"],
      }).scopes_supported,
    ).toEqual(["read", "write"]);
  });

  it("carries DPoP signing algs and overridden supported lists", () => {
    const metadata = buildAuthorizationServerMetadata({
      issuer: "https://example.com",
      grantTypesSupported: ["authorization_code", "refresh_token"],
      responseTypesSupported: ["code"],
      tokenEndpointAuthMethodsSupported: ["client_secret_basic"],
      codeChallengeMethodsSupported: ["S256"],
      dpopSigningAlgValuesSupported: ["ES256", "RS256"],
    });
    expect(metadata.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_basic",
    ]);
    expect(metadata.dpop_signing_alg_values_supported).toEqual([
      "ES256",
      "RS256",
    ]);
  });
});
