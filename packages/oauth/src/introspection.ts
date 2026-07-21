/**
 * OAuth 2.0 Token Introspection (RFC 7662).
 *
 * A protected POST endpoint a Resource Server queries to learn whether a token
 * is currently active and, if so, its metadata. The endpoint **MUST** be
 * protected (RFC 7662 §2.1) so it cannot be used as a token-scanning oracle —
 * hence {@link IntrospectionConfig.authenticate} is required, not optional.
 *
 * The lib owns only the protocol mechanics: it asks the caller to look the token
 * up (storage stays in the consuming package, see `./store`), derives the
 * `active` flag, and maps the record to the snake_case response. A DPoP-bound
 * token surfaces its key thumbprint as `cnf: { jkt }` so the RS can complete the
 * proof-of-possession binding via `@dwk/dpop`.
 *
 * @see https://www.rfc-editor.org/rfc/rfc7662
 */

import { hostFromUrl } from "@dwk/log";

import { OAuthError, oauthErrorResponse } from "./errors.js";
import {
  json,
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
import type { IntrospectionTokenRecord } from "./store.js";

/**
 * Authenticates the calling Resource Server / client at a protected endpoint.
 *
 * Receives the request and, when the handler could extract one from the body,
 * the requested `client_id`. The handler passes a **pre-parse clone** of the
 * request, so an authenticator that itself reads the body (e.g. a
 * `client_secret_post` credential, or matching the authenticated client against
 * `clientId` per RFC 9126 §2.1) does not disturb the handler's own parse.
 */
export type EndpointAuthenticator = (
  request: Request,
  clientId?: string,
) => boolean | Promise<boolean>;

/** Configuration for {@link createIntrospectionHandler}. */
export interface IntrospectionConfig extends ObservabilityConfig {
  /**
   * Look up the presented token, returning the record to introspect or `null`
   * if it is unknown. The optional `tokenTypeHint` is the client's
   * `token_type_hint` (RFC 7662 §2.1) — a non-binding optimization the store may
   * ignore. Storage is the consuming package's concern; this stays plain-data.
   */
  readonly lookupToken: (
    token: string,
    tokenTypeHint?: string,
  ) => Promise<IntrospectionTokenRecord | null>;
  /**
   * Authenticate the caller. **Required** — an unprotected introspection
   * endpoint is a token-scanning oracle (RFC 7662 §2.1). Return `false` to
   * reject with `401 invalid_client`.
   */
  readonly authenticate: EndpointAuthenticator;
  /** Current time (seconds since the epoch). Defaults to `Date.now()`. */
  readonly now?: () => number;
}

/** The JSON shape of an introspection response (RFC 7662 §2.2). */
export interface IntrospectionResponse {
  readonly active: boolean;
  readonly scope?: string;
  readonly client_id?: string;
  readonly username?: string;
  readonly token_type?: string;
  readonly exp?: number;
  readonly iat?: number;
  readonly nbf?: number;
  readonly sub?: string;
  readonly aud?: string | readonly string[];
  readonly iss?: string;
  readonly jti?: string;
  readonly cnf?: { readonly jkt: string };
}

/** The single inactive response RFC 7662 §2.2 mandates for any non-active token. */
const INACTIVE: IntrospectionResponse = { active: false };

/**
 * Whether `record` represents a currently-active token at `now`. A record is
 * active unless it is `null`, explicitly `active: false`, revoked, past its
 * `expiresAt`, or before its `notBefore`. Pure and side-effect-free.
 */
export function isTokenActive(
  record: IntrospectionTokenRecord | null,
  now: number,
): boolean {
  if (record === null) return false;
  if (record.active === false) return false;
  if (record.revoked === true) return false;
  if (record.expiresAt !== undefined && now >= record.expiresAt) return false;
  if (record.notBefore !== undefined && now < record.notBefore) return false;
  return true;
}

/**
 * Map an active token record to its RFC 7662 response, emitting only members the
 * record actually carries (so the response never advertises empty claims). The
 * caller MUST have already established the token is active.
 */
export function buildIntrospectionResponse(
  record: IntrospectionTokenRecord,
): IntrospectionResponse {
  const response: Record<string, unknown> = { active: true };
  if (record.scope !== undefined) response.scope = record.scope;
  if (record.clientId !== undefined) response.client_id = record.clientId;
  if (record.username !== undefined) response.username = record.username;
  if (record.tokenType !== undefined) response.token_type = record.tokenType;
  if (record.expiresAt !== undefined) response.exp = record.expiresAt;
  if (record.issuedAt !== undefined) response.iat = record.issuedAt;
  if (record.notBefore !== undefined) response.nbf = record.notBefore;
  if (record.subject !== undefined) response.sub = record.subject;
  if (record.audience !== undefined) response.aud = record.audience;
  if (record.issuer !== undefined) response.iss = record.issuer;
  if (record.tokenId !== undefined) response.jti = record.tokenId;
  if (record.jkt !== undefined) response.cnf = { jkt: record.jkt };
  return response as unknown as IntrospectionResponse;
}

/**
 * Create the introspection endpoint handler. The returned handler accepts a
 * `POST` request and returns the introspection JSON; route it at whatever path
 * the deployer mounts (it is path-agnostic).
 */
export function createIntrospectionHandler(
  config: IntrospectionConfig,
): (request: Request) => Promise<Response> {
  const obs = resolveObservability(config);
  const clock = config.now ?? (() => Math.floor(Date.now() / 1000));

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

    // Protect the endpoint first, so an unauthenticated caller learns nothing
    // about any token (not even "unknown" vs "known") — the token lookup stays
    // after this gate. Reading the (small) form body up front is not sensitive.
    const clientId = form.get("client_id") ?? undefined;
    if (!(await config.authenticate(authRequest, clientId))) {
      emit(obs, "warn", OAuthLogEvent.IntrospectionRejected, {
        reason: "unauthenticated",
      });
      return oauthErrorResponse(
        OAuthError.InvalidClient,
        "introspection requires client authentication",
        401,
        { "WWW-Authenticate": wwwAuthenticateChallenge(request) },
      );
    }

    const token = form.get("token") ?? "";
    if (!token) {
      return oauthErrorResponse(
        OAuthError.InvalidRequest,
        "`token` is required",
      );
    }
    const hint = form.get("token_type_hint") ?? undefined;

    const record = await config.lookupToken(token, hint);
    if (!isTokenActive(record, clock())) {
      emit(obs, "info", OAuthLogEvent.IntrospectionInactive);
      return json(INACTIVE);
    }

    // `record` is non-null here: isTokenActive(null) is false.
    const active = record as IntrospectionTokenRecord;
    emit(obs, "info", OAuthLogEvent.IntrospectionActive, {
      clientHost: active.clientId ? hostFromUrl(active.clientId) : undefined,
    });
    return json(buildIntrospectionResponse(active));
  };
}
