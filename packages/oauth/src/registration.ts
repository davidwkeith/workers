/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591).
 *
 * A POST endpoint where a client submits its metadata and receives an issued
 * `client_id` (and, for confidential clients, a `client_secret`). The lib
 * validates the metadata against the registered standard fields and the
 * server's supported value lists, normalizes defaults, mints the identifier(s),
 * and delegates persistence to {@link ClientRegistrationConfig.saveClient}.
 *
 * Validation is deliberately strict on the security-relevant fields
 * (`redirect_uris`, `token_endpoint_auth_method`, and the
 * grant/response-type pairing) and ignores unrecognized members rather than
 * echoing arbitrary client-supplied data back as registered metadata.
 *
 * @see https://www.rfc-editor.org/rfc/rfc7591
 */

import { hostFromUrl } from "@dwk/log";

import { randomIdentifier } from "./encoding";
import { OAuthError, oauthErrorResponse, type OAuthErrorCode } from "./errors";
import { json, methodNotAllowed, readJson } from "./http";
import { OAuthLogEvent } from "./log";
import {
  emit,
  resolveObservability,
  type ObservabilityConfig,
} from "./observability";
import type { EndpointAuthenticator } from "./introspection";
import type { ClientRecord } from "./store";

const DEFAULT_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;
const DEFAULT_RESPONSE_TYPES = ["code"] as const;
const DEFAULT_AUTH_METHODS = [
  "none",
  "client_secret_basic",
  "client_secret_post",
] as const;

/** Configuration for {@link createClientRegistrationHandler}. */
export interface ClientRegistrationConfig extends ObservabilityConfig {
  /** Persist a newly registered client record. */
  readonly saveClient: (record: ClientRecord) => Promise<void>;
  /**
   * Optionally authenticate the caller (RFC 7591 §3: an "initial access token"
   * may gate open registration). Omit to allow open registration. Return
   * `false` to reject with `401 invalid_client`.
   */
  readonly authenticate?: EndpointAuthenticator;
  /** Mint the `client_id`. Defaults to a 256-bit random base64url string. */
  readonly generateClientId?: () => string;
  /** Mint the `client_secret`. Defaults to a 256-bit random base64url string. */
  readonly generateClientSecret?: () => string;
  /**
   * Extra redirect-URI policy applied after structural validation (e.g. an
   * allowlist of hosts). Return `false` to reject with `invalid_redirect_uri`.
   */
  readonly redirectUriPolicy?: (uri: string) => boolean;
  /** Grant types the server allows. Defaults to authorization_code + refresh_token. */
  readonly grantTypesSupported?: readonly string[];
  /** Response types the server allows. Defaults to `["code"]`. */
  readonly responseTypesSupported?: readonly string[];
  /** Token-endpoint auth methods the server allows. Defaults to none/basic/post. */
  readonly tokenEndpointAuthMethodsSupported?: readonly string[];
  /** Current time (seconds since the epoch). Defaults to `Date.now()`. */
  readonly now?: () => number;
}

/** A validation failure: the error code and a human-readable description. */
interface MetadataError {
  readonly error: OAuthErrorCode;
  readonly description: string;
}

/** Recognized RFC 7591 string-valued metadata members echoed back on success. */
const STRING_FIELDS = [
  "client_name",
  "client_uri",
  "logo_uri",
  "scope",
  "tos_uri",
  "policy_uri",
  "jwks_uri",
  "software_id",
  "software_version",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Whether `uri` is an acceptable redirect URI: a parseable absolute URL with no
 * fragment component (RFC 7591 §2 / RFC 6749 §3.1.2 — the fragment is reserved
 * for the response and must not be pre-registered).
 */
function isValidRedirectUri(uri: string): boolean {
  try {
    return new URL(uri).hash === "";
  } catch {
    return false;
  }
}

/**
 * Validate and normalize submitted client metadata. Returns the normalized
 * metadata (defaults applied, only recognized members retained) or a
 * {@link MetadataError}. Pure and side-effect-free, so it unit-tests directly.
 */
export function validateClientMetadata(
  input: unknown,
  config: ClientRegistrationConfig,
): { readonly metadata: Record<string, unknown> } | MetadataError {
  if (!isObject(input)) {
    return {
      error: OAuthError.InvalidClientMetadata,
      description: "request body must be a JSON object",
    };
  }

  const authMethods =
    config.tokenEndpointAuthMethodsSupported ?? DEFAULT_AUTH_METHODS;
  const grantTypesSupported = config.grantTypesSupported ?? DEFAULT_GRANT_TYPES;
  const responseTypesSupported =
    config.responseTypesSupported ?? DEFAULT_RESPONSE_TYPES;

  // token_endpoint_auth_method (default per RFC 7591 §2).
  const authMethod = input.token_endpoint_auth_method ?? "client_secret_basic";
  if (typeof authMethod !== "string" || !authMethods.includes(authMethod)) {
    return {
      error: OAuthError.InvalidClientMetadata,
      description: `unsupported token_endpoint_auth_method: ${String(authMethod)}`,
    };
  }

  // grant_types / response_types (defaults per RFC 7591 §2).
  const requestedGrants = input.grant_types ?? ["authorization_code"];
  if (!isStringArray(requestedGrants)) {
    return {
      error: OAuthError.InvalidClientMetadata,
      description: "grant_types must be an array of strings",
    };
  }
  for (const grant of requestedGrants) {
    if (!grantTypesSupported.includes(grant)) {
      return {
        error: OAuthError.InvalidClientMetadata,
        description: `unsupported grant_type: ${grant}`,
      };
    }
  }

  const requestedResponses = input.response_types ?? ["code"];
  if (!isStringArray(requestedResponses)) {
    return {
      error: OAuthError.InvalidClientMetadata,
      description: "response_types must be an array of strings",
    };
  }
  for (const responseType of requestedResponses) {
    if (!responseTypesSupported.includes(responseType)) {
      return {
        error: OAuthError.InvalidClientMetadata,
        description: `unsupported response_type: ${responseType}`,
      };
    }
  }

  // Grant/response-type consistency (RFC 7591 §2): authorization_code ⇔ code.
  const usesCode = requestedGrants.includes("authorization_code");
  const wantsCode = requestedResponses.includes("code");
  if (usesCode !== wantsCode) {
    return {
      error: OAuthError.InvalidClientMetadata,
      description:
        "grant_types and response_types are inconsistent: " +
        "`authorization_code` requires `code` and vice versa",
    };
  }

  // redirect_uris: required for redirect-based flows.
  const needsRedirect =
    requestedGrants.includes("authorization_code") ||
    requestedGrants.includes("implicit");
  const redirectUris = input.redirect_uris;
  if (redirectUris !== undefined) {
    if (!isStringArray(redirectUris)) {
      return {
        error: OAuthError.InvalidRedirectUri,
        description: "redirect_uris must be an array of strings",
      };
    }
    for (const uri of redirectUris) {
      if (!isValidRedirectUri(uri)) {
        return {
          error: OAuthError.InvalidRedirectUri,
          description: `invalid redirect_uri: ${uri}`,
        };
      }
      if (config.redirectUriPolicy && !config.redirectUriPolicy(uri)) {
        return {
          error: OAuthError.InvalidRedirectUri,
          description: `redirect_uri not permitted: ${uri}`,
        };
      }
    }
  }
  if (
    needsRedirect &&
    (!isStringArray(redirectUris) || redirectUris.length === 0)
  ) {
    return {
      error: OAuthError.InvalidRedirectUri,
      description: "redirect_uris is required for the requested grant_types",
    };
  }

  // contacts: optional array of strings.
  if (input.contacts !== undefined && !isStringArray(input.contacts)) {
    return {
      error: OAuthError.InvalidClientMetadata,
      description: "contacts must be an array of strings",
    };
  }

  // jwks: optional object.
  if (input.jwks !== undefined && !isObject(input.jwks)) {
    return {
      error: OAuthError.InvalidClientMetadata,
      description: "jwks must be a JSON object",
    };
  }

  // Recognized string fields must be strings when present.
  for (const field of STRING_FIELDS) {
    if (input[field] !== undefined && typeof input[field] !== "string") {
      return {
        error: OAuthError.InvalidClientMetadata,
        description: `${field} must be a string`,
      };
    }
  }

  // Assemble normalized metadata: defaults applied, only recognized members.
  const metadata: Record<string, unknown> = {
    token_endpoint_auth_method: authMethod,
    grant_types: requestedGrants,
    response_types: requestedResponses,
  };
  if (redirectUris !== undefined) metadata.redirect_uris = redirectUris;
  if (input.contacts !== undefined) metadata.contacts = input.contacts;
  if (input.jwks !== undefined) metadata.jwks = input.jwks;
  for (const field of STRING_FIELDS) {
    if (input[field] !== undefined) metadata[field] = input[field];
  }

  return { metadata };
}

/**
 * Create the dynamic-client-registration endpoint handler. On success it returns
 * `201` with the client information response (RFC 7591 §3.2.1): the issued
 * `client_id`/`client_id_issued_at`, an optional `client_secret`
 * (+`client_secret_expires_at: 0`, meaning non-expiring) for confidential
 * clients, and the registered metadata.
 */
export function createClientRegistrationHandler(
  config: ClientRegistrationConfig,
): (request: Request) => Promise<Response> {
  const obs = resolveObservability(config);
  const clock = config.now ?? (() => Math.floor(Date.now() / 1000));
  const newClientId = config.generateClientId ?? (() => randomIdentifier());
  const newClientSecret =
    config.generateClientSecret ?? (() => randomIdentifier());

  return async (request) => {
    if (request.method.toUpperCase() !== "POST") {
      return methodNotAllowed("POST");
    }

    // Clone so an authenticator that reads the body (e.g. an initial access
    // token in the body) does not disturb the handler's own JSON parse. A
    // registration request carries no `client_id` (one is being issued).
    if (config.authenticate && !(await config.authenticate(request.clone()))) {
      emit(obs, "warn", OAuthLogEvent.ClientRegistrationRejected, {
        reason: "unauthenticated",
      });
      return oauthErrorResponse(
        OAuthError.InvalidClient,
        "client registration requires authorization",
        401,
        { "WWW-Authenticate": "Bearer" },
      );
    }

    const body = await readJson(request);
    const result = validateClientMetadata(body, config);
    if ("error" in result) {
      emit(obs, "warn", OAuthLogEvent.ClientRegistrationRejected, {
        reason: result.error,
      });
      return oauthErrorResponse(result.error, result.description);
    }

    const { metadata } = result;
    const issuedAt = clock();
    const clientId = newClientId();
    const confidential = metadata.token_endpoint_auth_method !== "none";
    const clientSecret = confidential ? newClientSecret() : undefined;

    const record: ClientRecord = {
      clientId,
      clientIdIssuedAt: issuedAt,
      ...(clientSecret ? { clientSecret } : {}),
      metadata,
    };
    await config.saveClient(record);

    emit(obs, "info", OAuthLogEvent.ClientRegistered, {
      clientHost: hostFromUrl(clientId),
    });
    const response: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      ...(clientSecret
        ? { client_secret: clientSecret, client_secret_expires_at: 0 }
        : {}),
      ...metadata,
    };
    return json(response, 201);
  };
}
