import { describe, expect, it } from "vitest";

import { OAuthError, oauthErrorResponse } from "./errors.js";

describe("oauthErrorResponse", () => {
  it("builds a JSON error body with error + description", async () => {
    const res = oauthErrorResponse(
      OAuthError.InvalidRequest,
      "`token` is required",
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({
      error: "invalid_request",
      error_description: "`token` is required",
    });
  });

  it("omits error_description when not supplied", async () => {
    const res = oauthErrorResponse(OAuthError.InvalidClient);
    expect(await res.json()).toEqual({ error: "invalid_client" });
  });

  it("honors a custom status and extra headers", async () => {
    const res = oauthErrorResponse(
      OAuthError.InvalidClient,
      "auth required",
      401,
      { "WWW-Authenticate": "Bearer" },
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("exposes only registered OAuth error codes", () => {
    // Spot-check that the registry uses the exact registered spellings clients
    // switch on; a typo here is a conformance bug.
    expect(OAuthError.UnsupportedGrantType).toBe("unsupported_grant_type");
    expect(OAuthError.InvalidClientMetadata).toBe("invalid_client_metadata");
    expect(OAuthError.InvalidRedirectUri).toBe("invalid_redirect_uri");
    expect(OAuthError.InvalidDpopProof).toBe("invalid_dpop_proof");
    expect(OAuthError.InvalidRequestUri).toBe("invalid_request_uri");
  });
});
