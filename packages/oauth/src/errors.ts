/**
 * The shared OAuth 2.0 error registry.
 *
 * OAuth defines a fixed vocabulary of `error` codes across its specs; emitting a
 * non-registered code (the finding in [#39]) makes a server fail conformance and
 * confuses standards-compliant clients, which switch on these exact strings.
 * Centralizing them here lets `@dwk/indieauth` and the eventual Solid-OIDC OP
 * share one audited registry rather than re-spelling literals per call site.
 *
 * @see https://www.rfc-editor.org/rfc/rfc6749#section-5.2 (token endpoint)
 * @see https://www.rfc-editor.org/rfc/rfc7591#section-3.2.2 (registration)
 * @see https://www.rfc-editor.org/rfc/rfc9449#section-12 (DPoP)
 */

/** The registered OAuth 2.0 `error` codes this lib emits. */
export const OAuthError = {
  // RFC 6749 §5.2 — token endpoint / general protocol errors.
  /** The request is missing a parameter, malformed, or otherwise invalid. */
  InvalidRequest: "invalid_request",
  /** Client authentication failed or the client is unknown. */
  InvalidClient: "invalid_client",
  /** The grant (code, refresh token, …) is invalid, expired, or revoked. */
  InvalidGrant: "invalid_grant",
  /** The authenticated client is not authorized to use this grant type. */
  UnauthorizedClient: "unauthorized_client",
  /** The grant type is not supported by the authorization server. */
  UnsupportedGrantType: "unsupported_grant_type",
  /** The requested scope is invalid, unknown, or exceeds what was granted. */
  InvalidScope: "invalid_scope",
  /** An unexpected server-side condition prevented fulfilling the request. */
  ServerError: "server_error",
  /** The server is temporarily overloaded or under maintenance. */
  TemporarilyUnavailable: "temporarily_unavailable",

  // RFC 7591 §3.2.2 — dynamic client registration.
  /** One or more submitted client metadata fields are invalid. */
  InvalidClientMetadata: "invalid_client_metadata",
  /** One or more `redirect_uris` are invalid. */
  InvalidRedirectUri: "invalid_redirect_uri",

  // RFC 7009 §2.2.1 — revocation.
  /** The server does not support revoking the presented token type. */
  UnsupportedTokenType: "unsupported_token_type",

  // RFC 9126 §2.3 — pushed authorization requests.
  /** The `request_uri` is unknown, expired, or already consumed. */
  InvalidRequestUri: "invalid_request_uri",

  // RFC 9449 §5 / §12 — DPoP.
  /** The DPoP proof is missing or fails verification. */
  InvalidDpopProof: "invalid_dpop_proof",
} as const;

/** Union of the registered error-code string literals in {@link OAuthError}. */
export type OAuthErrorCode = (typeof OAuthError)[keyof typeof OAuthError];

const JSON_HEADERS = { "content-type": "application/json" } as const;

/**
 * Build an OAuth 2.0 error response (RFC 6749 §5.2): a JSON body with `error`
 * and optional `error_description`. `error` is typed to the registry so a
 * non-registered code cannot be emitted by accident.
 *
 * Extra headers (e.g. `WWW-Authenticate` for a `401`) are merged in; callers
 * MUST keep `error_description` free of secrets and untrusted echoes.
 */
export function oauthErrorResponse(
  error: OAuthErrorCode,
  description?: string,
  status = 400,
  headers?: Record<string, string>,
): Response {
  const body = description
    ? { error, error_description: description }
    : { error };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}
