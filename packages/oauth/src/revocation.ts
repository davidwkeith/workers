/**
 * OAuth 2.0 Token Revocation (RFC 7009).
 *
 * A POST endpoint where a client asks the authorization server to invalidate a
 * token. Revocation is **idempotent and forgiving**: an unknown, malformed, or
 * already-revoked token still yields `200` (RFC 7009 §2.2), so a client can
 * retry safely and cannot probe token existence by status code. The lib owns the
 * protocol; the actual invalidation is delegated to
 * {@link RevocationConfig.revokeToken}, backed by the consuming package's store.
 *
 * @see https://www.rfc-editor.org/rfc/rfc7009
 */

import { OAuthError, oauthErrorResponse } from "./errors.js";
import {
  methodNotAllowed,
  readForm,
  wwwAuthenticateChallenge,
} from "./http.js";
import { OAuthLogEvent } from "./log.js";
import {
  emit,
  resolveObservability,
  type ObservabilityConfig,
} from "./observability.js";
import type { EndpointAuthenticator } from "./introspection.js";

/** Configuration for {@link createRevocationHandler}. */
export interface RevocationConfig extends ObservabilityConfig {
  /**
   * Revoke the presented token. MUST be idempotent and MUST NOT throw for an
   * unknown token — RFC 7009 §2.2 requires `200` regardless. The optional
   * `tokenTypeHint` is the client's non-binding `token_type_hint`.
   */
  readonly revokeToken: (
    token: string,
    tokenTypeHint?: string,
  ) => Promise<void>;
  /**
   * Optionally authenticate the caller (RFC 7009 §2.1: confidential clients
   * MUST be authenticated). Omit for public clients using the `none` method.
   * Return `false` to reject with `401 invalid_client`.
   */
  readonly authenticate?: EndpointAuthenticator;
}

/**
 * Create the revocation endpoint handler. The returned handler accepts a `POST`
 * request and returns `200` with an empty body on success.
 */
export function createRevocationHandler(
  config: RevocationConfig,
): (request: Request) => Promise<Response> {
  const obs = resolveObservability(config);

  return async (request) => {
    if (request.method.toUpperCase() !== "POST") {
      return methodNotAllowed("POST");
    }

    // Clone before consuming the body so the authenticator can read it too.
    const authRequest = request.clone();
    const form = await readForm(request);
    if (form === null) {
      return oauthErrorResponse(
        OAuthError.InvalidRequest,
        "request parameters must not be included more than once",
      );
    }

    const clientId = form.get("client_id") ?? undefined;
    if (
      config.authenticate &&
      !(await config.authenticate(authRequest, clientId))
    ) {
      emit(obs, "warn", OAuthLogEvent.RevocationRejected, {
        reason: "unauthenticated",
      });
      return oauthErrorResponse(
        OAuthError.InvalidClient,
        "revocation requires client authentication",
        401,
        { "WWW-Authenticate": wwwAuthenticateChallenge(request) },
      );
    }

    const token = form.get("token") ?? "";
    // A missing `token` is the one malformed-request case RFC 7009 §2.1 lets us
    // reject; a present-but-unknown token is still a success.
    if (!token) {
      return oauthErrorResponse(
        OAuthError.InvalidRequest,
        "`token` is required",
      );
    }
    const hint = form.get("token_type_hint") ?? undefined;

    await config.revokeToken(token, hint);
    emit(obs, "info", OAuthLogEvent.TokenRevoked);
    return new Response(null, { status: 200 });
  };
}
