/**
 * Pushed Authorization Requests (RFC 9126).
 *
 * The client POSTs its authorization-request parameters directly to this
 * endpoint; the server validates and stores them and hands back a short-lived,
 * single-use `request_uri`. The client then starts the normal authorization
 * flow with just `client_id` + `request_uri`, so the request parameters never
 * travel through the browser/redirect and cannot be tampered with.
 *
 * This lib owns the *push* side (validate → store → mint `request_uri`). The
 * *consume* side lives at the authorization endpoint in the consuming package:
 * use {@link parseRequestUri} to recover the reference and the store's
 * single-use `consume` ({@link PushedAuthorizationStore}). When DPoP binding is
 * enabled and the push carries a `DPoP` header, the proof is verified via
 * `@dwk/dpop` and its `jkt` recorded so the eventual token is key-bound
 * (RFC 9449 §10).
 *
 * @see https://www.rfc-editor.org/rfc/rfc9126
 */

import { verifyDpopProof } from "@dwk/dpop";
import { hostFromUrl } from "@dwk/log";

import { randomIdentifier } from "./encoding.js";
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
import type { EndpointAuthenticator } from "./introspection.js";
import type { PushedRequestRecord } from "./store.js";

/** The URN prefix RFC 9126 §2.2 mandates for a PAR `request_uri`. */
export const PUSHED_REQUEST_URI_PREFIX = "urn:ietf:params:oauth:request_uri:";

const DEFAULT_LIFETIME_SECONDS = 60;
/** Reference entropy in bytes: 256 bits of unguessable `request_uri`. */
const REFERENCE_BYTES = 32;

/**
 * Client-authentication parameters that a `client_secret_post` /
 * `private_key_jwt` client sends in the same form body as the authorization
 * parameters. They authenticate the request; they are not part of the pushed
 * authorization request and MUST NOT be persisted into the stored record, where
 * a client's credential would otherwise sit at rest.
 */
const CLIENT_AUTH_PARAMS = new Set([
  "client_secret",
  "client_assertion",
  "client_assertion_type",
]);

/** Build the `request_uri` URN for a stored reference. */
export function requestUriFor(reference: string): string {
  return `${PUSHED_REQUEST_URI_PREFIX}${reference}`;
}

/**
 * Recover the opaque reference from a PAR `request_uri`, or `null` if `uri` is
 * not a `urn:ietf:params:oauth:request_uri:` value. Use this at the
 * authorization endpoint before calling the store's single-use `consume`.
 */
export function parseRequestUri(uri: string): string | null {
  if (!uri.startsWith(PUSHED_REQUEST_URI_PREFIX)) return null;
  const reference = uri.slice(PUSHED_REQUEST_URI_PREFIX.length);
  return reference.length > 0 ? reference : null;
}

/** Configuration for {@link createPushedAuthorizationRequestHandler}. */
export interface PushedAuthorizationRequestConfig extends ObservabilityConfig {
  /** Persist a freshly pushed request (keyed by its `reference`). */
  readonly saveRequest: (record: PushedRequestRecord) => Promise<void>;
  /**
   * Optionally authenticate the caller (RFC 9126 §2: clients authenticate as at
   * the token endpoint). Omit for public clients. Return `false` to reject with
   * `401 invalid_client`.
   */
  readonly authenticate?: EndpointAuthenticator;
  /**
   * Optional extra validation of the pushed parameters (e.g. requiring PKCE or a
   * known `response_type`). Return an error description string to reject with
   * `400 invalid_request`, or `null` to accept.
   */
  readonly validate?: (
    params: Readonly<Record<string, string>>,
  ) => string | null | Promise<string | null>;
  /** `request_uri` lifetime in seconds. Defaults to 60 (RFC 9126 favors short). */
  readonly lifetimeSeconds?: number;
  /**
   * Enable RFC 9449 DPoP binding: when `true` and the push carries a `DPoP`
   * header, the proof is verified and its `jkt` recorded on the request. The
   * `htu` is bound to {@link endpoint} (falling back to the request URL).
   */
  readonly dpopBinding?: boolean;
  /** Absolute PAR endpoint URL, used as the DPoP `htu`. */
  readonly endpoint?: string;
  /** Current time (seconds since the epoch). Defaults to `Date.now()`. */
  readonly now?: () => number;
}

/**
 * Create the pushed-authorization-request endpoint handler. On success it
 * returns `201` with `{ request_uri, expires_in }` (RFC 9126 §2.2).
 */
export function createPushedAuthorizationRequestHandler(
  config: PushedAuthorizationRequestConfig,
): (request: Request) => Promise<Response> {
  const obs = resolveObservability(config);
  const clock = config.now ?? (() => Math.floor(Date.now() / 1000));
  const lifetime = config.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;

  return async (request) => {
    if (request.method.toUpperCase() !== "POST") {
      return methodNotAllowed("POST");
    }

    // Clone before consuming the body so the authenticator can read it too.
    const authRequest = request.clone();
    const form = await readForm(request);
    if (form === null) {
      emit(obs, "warn", OAuthLogEvent.PushedRequestRejected, {
        reason: "duplicate_parameter",
      });
      return oauthErrorResponse(
        OAuthError.InvalidRequest,
        "request parameters must not be included more than once",
      );
    }

    // RFC 9126 §2.1: the PAR body MUST NOT itself contain a `request_uri`.
    if (form.has("request_uri")) {
      emit(obs, "warn", OAuthLogEvent.PushedRequestRejected, {
        reason: "request_uri_present",
      });
      return oauthErrorResponse(
        OAuthError.InvalidRequest,
        "`request_uri` is not allowed in a pushed authorization request",
      );
    }

    const clientId = form.get("client_id") ?? "";
    if (!clientId) {
      emit(obs, "warn", OAuthLogEvent.PushedRequestRejected, {
        reason: "client_id_missing",
      });
      return oauthErrorResponse(
        OAuthError.InvalidRequest,
        "`client_id` is required",
      );
    }

    // Authenticate with the extracted `client_id` in hand, so the authenticator
    // can enforce the RFC 9126 §2.1 match (authenticated client == client_id).
    if (
      config.authenticate &&
      !(await config.authenticate(authRequest, clientId))
    ) {
      emit(obs, "warn", OAuthLogEvent.PushedRequestRejected, {
        reason: "unauthenticated",
      });
      return oauthErrorResponse(
        OAuthError.InvalidClient,
        "pushed authorization requests require client authentication",
        401,
        { "WWW-Authenticate": wwwAuthenticateChallenge(request) },
      );
    }

    const params: Record<string, string> = {};
    for (const [key, value] of form) {
      // Never persist the client's authentication credential (see above).
      if (CLIENT_AUTH_PARAMS.has(key)) continue;
      params[key] = value;
    }

    if (config.validate) {
      const problem = await config.validate(params);
      if (problem !== null && problem !== undefined) {
        emit(obs, "warn", OAuthLogEvent.PushedRequestRejected, {
          reason: "validation_failed",
          clientHost: hostFromUrl(clientId),
        });
        return oauthErrorResponse(OAuthError.InvalidRequest, problem);
      }
    }

    let jkt: string | undefined;
    if (config.dpopBinding) {
      const proof = request.headers.get("DPoP");
      if (proof) {
        const dpop = await verifyDpopProof({
          proof,
          htm: "POST",
          htu: config.endpoint ?? request.url,
        });
        if (!dpop.valid || !dpop.jkt) {
          emit(obs, "warn", OAuthLogEvent.PushedRequestRejected, {
            reason: "dpop_invalid",
            clientHost: hostFromUrl(clientId),
          });
          return oauthErrorResponse(
            OAuthError.InvalidDpopProof,
            `DPoP proof verification failed: ${dpop.reason ?? "unknown"}`,
          );
        }
        jkt = dpop.jkt;
      }
    }

    const reference = randomIdentifier(REFERENCE_BYTES);
    const record: PushedRequestRecord = {
      reference,
      clientId,
      params,
      expiresAt: clock() + lifetime,
      ...(jkt ? { jkt } : {}),
    };
    await config.saveRequest(record);

    emit(obs, "info", OAuthLogEvent.PushedRequestStored, {
      clientHost: hostFromUrl(clientId),
    });
    return json(
      { request_uri: requestUriFor(reference), expires_in: lifetime },
      201,
    );
  };
}
