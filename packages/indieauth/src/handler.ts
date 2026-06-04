/**
 * The IndieAuth fetch handler: authorization, token, revocation, and metadata
 * endpoints wired to the D1 store and `@dwk/dpop`. Routing matches the request
 * pathname against each configured endpoint's path, so the handler is mountable
 * under any prefix simply by configuring absolute endpoint URLs.
 */

import { verifyDpopProof } from "@dwk/dpop";
import { hostFromUrl, type LogFields } from "@dwk/log";

import {
  resolveConfig,
  type AuthorizationApproval,
  type AuthorizationRequest,
  type IndieAuthConfig,
  type ProfileInfo,
  type ResolvedConfig,
} from "./config";
import { IndieAuthLogEvent } from "./log";
import { buildServerMetadata } from "./metadata";
import { isSupportedChallengeMethod, verifyPkce } from "./pkce";
import { signAccessToken, verifyAccessToken } from "./token";
import {
  createIndieAuthStore,
  type AuthorizationCodeRecord,
  type IndieAuthStoreEnv,
} from "./store";

/** Cloudflare bindings required by the IndieAuth handler. */
export interface IndieAuthEnv extends IndieAuthStoreEnv {
  /** HMAC signing key material for issued access tokens (secret binding). */
  readonly TOKEN_SIGNING_KEY: string;
}

/** A `fetch`-compatible Worker handler. */
export type IndieAuthHandler = (
  request: Request,
  env: IndieAuthEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

const JSON_HEADERS = { "content-type": "application/json" } as const;
/** Length of the random authorization code, in bytes (base64url-encoded). */
const CODE_BYTES = 32;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

/** An OAuth 2.0 error response body (RFC 6749 §5.2). */
function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return json({ error, error_description: description }, status);
}

/**
 * Emit a structured event on both the logger and the metrics seam, which share
 * one event vocabulary (see `@dwk/log`): `warn` for handled-but-notable
 * rejections, `info` for normal outcomes. Honors the redaction policy — callers
 * pass only reason codes, sanitized hosts, and scopes, never codes or tokens.
 */
function emit(
  config: ResolvedConfig,
  level: "info" | "warn",
  event: string,
  fields?: LogFields,
): void {
  config.logger[level](event, fields);
  config.metrics.count(event, fields);
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Validate that the required secret binding is present (fail loudly). */
function assertSigningKey(env: IndieAuthEnv): string {
  if (!env.TOKEN_SIGNING_KEY || typeof env.TOKEN_SIGNING_KEY !== "string") {
    throw new Error(
      "@dwk/indieauth: missing required secret binding `TOKEN_SIGNING_KEY`",
    );
  }
  return env.TOKEN_SIGNING_KEY;
}

/** Build a redirect back to the client with error parameters. */
function redirectError(
  redirectUri: string,
  error: string,
  description: string,
  state: string,
  issuer: string,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  return Response.redirect(url.toString(), 302);
}

function parseProfile(profile: string | null): ProfileInfo | undefined {
  if (profile === null) return undefined;
  try {
    return JSON.parse(profile) as ProfileInfo;
  } catch {
    return undefined;
  }
}

/**
 * Handle `GET` to the authorization endpoint: validate the request, delegate
 * authentication/consent, then mint a single-use authorization code and
 * redirect back to the client.
 */
async function handleAuthorizationGet(
  request: Request,
  config: ResolvedConfig,
  store: ReturnType<typeof createIndieAuthStore>,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? "";

  // client_id and redirect_uri must be valid, fragment-free URLs before we can
  // redirect anywhere.
  if (!isHttpUrl(clientId)) {
    emit(config, "warn", IndieAuthLogEvent.AuthorizeRejected, {
      reason: "client_id_invalid",
    });
    return oauthError(
      "invalid_request",
      "`client_id` must be a valid URL without a fragment",
    );
  }
  if (!isHttpUrl(redirectUri)) {
    emit(config, "warn", IndieAuthLogEvent.AuthorizeRejected, {
      reason: "redirect_uri_invalid",
      clientHost: hostFromUrl(clientId),
    });
    return oauthError(
      "invalid_request",
      "`redirect_uri` must be a valid URL without a fragment",
    );
  }
  if (!(await config.redirectUriPolicy(clientId, redirectUri))) {
    emit(config, "warn", IndieAuthLogEvent.AuthorizeRejected, {
      reason: "redirect_uri_not_permitted",
      clientHost: hostFromUrl(clientId),
    });
    return oauthError(
      "invalid_request",
      "`redirect_uri` is not permitted for this `client_id`",
    );
  }

  // From here, protocol errors are reported by redirecting back to the client.
  const responseType = params.get("response_type") ?? "code";
  if (responseType !== "code") {
    emit(config, "warn", IndieAuthLogEvent.AuthorizeRejected, {
      reason: "unsupported_response_type",
      clientHost: hostFromUrl(clientId),
    });
    return redirectError(
      redirectUri,
      "unsupported_response_type",
      "only `response_type=code` is supported",
      state,
      config.issuer,
    );
  }

  const codeChallenge = params.get("code_challenge") ?? "";
  const codeChallengeMethod = params.get("code_challenge_method") ?? "";
  if (!codeChallenge || !isSupportedChallengeMethod(codeChallengeMethod)) {
    emit(config, "warn", IndieAuthLogEvent.AuthorizeRejected, {
      reason: "pkce_required",
      clientHost: hostFromUrl(clientId),
    });
    return redirectError(
      redirectUri,
      "invalid_request",
      "PKCE is required: supply `code_challenge` with `code_challenge_method=S256`",
      state,
      config.issuer,
    );
  }

  const scope = params.get("scope") ?? "";
  const scopes = scope.split(/\s+/).filter(Boolean);
  const authRequest: AuthorizationRequest = {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod,
    scope,
    scopes,
    ...(params.get("me") ? { me: params.get("me") as string } : {}),
  };

  const decision = await config.approveAuthorization(authRequest, request);
  // The hook may take over the exchange (login/consent page, IdP redirect).
  if (decision instanceof Response) return decision;

  return issueCode(decision, authRequest, config, store);
}

/** Persist the code and redirect back to the client with `code`/`state`/`iss`. */
async function issueCode(
  approval: AuthorizationApproval,
  authRequest: AuthorizationRequest,
  config: ResolvedConfig,
  store: ReturnType<typeof createIndieAuthStore>,
): Promise<Response> {
  const grantedScopes = approval.scopes ?? authRequest.scopes;
  const code = randomCode();
  await store.saveAuthorizationCode({
    code,
    clientId: authRequest.clientId,
    redirectUri: authRequest.redirectUri,
    scope: grantedScopes.join(" "),
    me: approval.me,
    codeChallenge: authRequest.codeChallenge,
    codeChallengeMethod: authRequest.codeChallengeMethod as "S256",
    profile: approval.profile ? JSON.stringify(approval.profile) : null,
    expiresAt:
      Math.floor(Date.now() / 1000) + config.authorizationCodeLifetimeSeconds,
  });

  emit(config, "info", IndieAuthLogEvent.AuthorizeApproved, {
    clientHost: hostFromUrl(authRequest.clientId),
  });
  const url = new URL(authRequest.redirectUri);
  url.searchParams.set("code", code);
  if (authRequest.state) url.searchParams.set("state", authRequest.state);
  url.searchParams.set("iss", config.issuer);
  return Response.redirect(url.toString(), 302);
}

/**
 * Redeem an authorization code: parse the form body, redeem the code (single
 * use), check the redirect-URI/client-id match, and verify PKCE. Returns the
 * redeemed record, or an error `Response`.
 */
async function redeemCode(
  request: Request,
  store: ReturnType<typeof createIndieAuthStore>,
  config: ResolvedConfig,
): Promise<AuthorizationCodeRecord | Response> {
  const form = await readForm(request);
  if (form.get("grant_type") !== "authorization_code") {
    emit(config, "warn", IndieAuthLogEvent.TokenRejected, {
      reason: "unsupported_grant_type",
    });
    return oauthError(
      "unsupported_grant_type",
      "only `grant_type=authorization_code` is supported",
    );
  }
  const code = form.get("code") ?? "";
  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const codeVerifier = form.get("code_verifier") ?? "";
  if (!code || !clientId || !redirectUri || !codeVerifier) {
    emit(config, "warn", IndieAuthLogEvent.TokenRejected, {
      reason: "invalid_request",
    });
    return oauthError(
      "invalid_request",
      "`code`, `client_id`, `redirect_uri`, and `code_verifier` are required",
    );
  }

  const record = await store.redeemAuthorizationCode(
    code,
    Math.floor(Date.now() / 1000),
  );
  if (record === null) {
    emit(config, "warn", IndieAuthLogEvent.TokenRejected, {
      reason: "invalid_grant",
      clientHost: hostFromUrl(clientId),
    });
    return oauthError(
      "invalid_grant",
      "authorization code is invalid or expired",
    );
  }
  if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
    emit(config, "warn", IndieAuthLogEvent.TokenRejected, {
      reason: "client_mismatch",
      clientHost: hostFromUrl(clientId),
    });
    return oauthError(
      "invalid_grant",
      "`client_id`/`redirect_uri` do not match the authorization request",
    );
  }
  if (
    !(await verifyPkce(
      codeVerifier,
      record.codeChallenge,
      record.codeChallengeMethod,
    ))
  ) {
    emit(config, "warn", IndieAuthLogEvent.TokenRejected, {
      reason: "pkce_failed",
      clientHost: hostFromUrl(clientId),
    });
    return oauthError("invalid_grant", "PKCE `code_verifier` does not match");
  }
  return record;
}

/**
 * Handle `POST` to the token endpoint: redeem the code, verify the DPoP proof,
 * and issue a DPoP-bound access token.
 */
async function handleToken(
  request: Request,
  config: ResolvedConfig,
  store: ReturnType<typeof createIndieAuthStore>,
  signingKey: string,
): Promise<Response> {
  const redeemed = await redeemCode(request, store, config);
  if (redeemed instanceof Response) return redeemed;

  // Tokens issued here are DPoP-bound: require a valid proof for this request.
  const proof = request.headers.get("DPoP");
  if (!proof) {
    emit(config, "warn", IndieAuthLogEvent.TokenRejected, {
      reason: "dpop_missing",
      clientHost: hostFromUrl(redeemed.clientId),
    });
    return oauthError(
      "invalid_dpop_proof",
      "a DPoP proof is required at the token endpoint",
    );
  }
  const dpop = await verifyDpopProof({
    proof,
    htm: "POST",
    htu: request.url,
  });
  if (!dpop.valid || !dpop.jkt) {
    emit(config, "warn", IndieAuthLogEvent.TokenRejected, {
      reason: "dpop_invalid",
      clientHost: hostFromUrl(redeemed.clientId),
    });
    return oauthError(
      "invalid_dpop_proof",
      `DPoP proof verification failed: ${dpop.reason ?? "unknown"}`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const minted = await signAccessToken(signingKey, {
    issuer: config.issuer,
    me: redeemed.me,
    clientId: redeemed.clientId,
    scope: redeemed.scope,
    jkt: dpop.jkt,
    lifetimeSeconds: config.accessTokenLifetimeSeconds,
    now,
  });
  await store.recordToken({
    jti: minted.claims.jti,
    clientId: redeemed.clientId,
    me: redeemed.me,
    scope: redeemed.scope,
    jkt: dpop.jkt,
    issuedAt: minted.claims.iat,
    expiresAt: minted.claims.exp,
  });

  emit(config, "info", IndieAuthLogEvent.TokenIssued, {
    clientHost: hostFromUrl(redeemed.clientId),
    scope: redeemed.scope,
  });
  const profile = parseProfile(redeemed.profile);
  return json({
    access_token: minted.token,
    token_type: "DPoP",
    scope: redeemed.scope,
    me: redeemed.me,
    expires_in: config.accessTokenLifetimeSeconds,
    ...(profile ? { profile } : {}),
  });
}

/**
 * Handle `POST` to the authorization endpoint: the IndieAuth profile-URL
 * exchange used by clients that only need to confirm the user's identity (no
 * access token, hence no DPoP). Returns `{ me, profile? }`.
 */
async function handleProfileExchange(
  request: Request,
  store: ReturnType<typeof createIndieAuthStore>,
  config: ResolvedConfig,
): Promise<Response> {
  const redeemed = await redeemCode(request, store, config);
  if (redeemed instanceof Response) return redeemed;
  const profile = parseProfile(redeemed.profile);
  return json({ me: redeemed.me, ...(profile ? { profile } : {}) });
}

/** Handle `POST` to the revocation endpoint (RFC 7009). Always returns 200. */
async function handleRevocation(
  request: Request,
  store: ReturnType<typeof createIndieAuthStore>,
  config: ResolvedConfig,
  signingKey: string,
): Promise<Response> {
  const form = await readForm(request);
  const token = form.get("token") ?? "";
  if (token) {
    // Recover the jti from the token to revoke the stored record. An invalid
    // token is silently accepted per RFC 7009 §2.2.
    const result = await verifyAccessToken(token, signingKey, {
      issuer: config.issuer,
    });
    if (result.valid) {
      await store.revokeToken(result.claims.jti);
      emit(config, "info", IndieAuthLogEvent.TokenRevoked, {
        clientHost: hostFromUrl(result.claims.client_id),
      });
    }
  }
  return new Response(null, { status: 200 });
}

/** Read an `application/x-www-form-urlencoded` body into `URLSearchParams`. */
async function readForm(request: Request): Promise<URLSearchParams> {
  const params = new URLSearchParams();
  try {
    const form = await request.formData();
    for (const [key, value] of form) {
      if (typeof value === "string") params.set(key, value);
    }
  } catch {
    // A malformed/empty body or wrong content-type yields empty params, so the
    // caller's validation fails gracefully with a 400 rather than throwing.
  }
  return params;
}

/**
 * Whether `value` is an `https`/`http` URL with no fragment. IndieAuth requires
 * both `client_id` and `redirect_uri` to be URLs and to carry no fragment
 * component, which guards against fragment-injection on the redirect.
 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return url.hash === "";
  } catch {
    return false;
  }
}

/**
 * Create the IndieAuth handler. The returned handler routes by pathname against
 * the configured endpoint URLs, so it is mountable under any path prefix.
 */
export function createIndieAuth(config: IndieAuthConfig): IndieAuthHandler {
  const resolved = resolveConfig(config);

  return async (request, env, _ctx) => {
    const signingKey = assertSigningKey(env);
    const store = createIndieAuthStore(env);
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (pathname === resolved.metadataPath) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(buildServerMetadata(resolved));
    }

    if (pathname === resolved.authorizationPath) {
      if (method === "GET") {
        return handleAuthorizationGet(request, resolved, store);
      }
      if (method === "POST") {
        return handleProfileExchange(request, store, resolved);
      }
      return methodNotAllowed("GET, POST");
    }

    if (pathname === resolved.tokenPath) {
      if (method !== "POST") return methodNotAllowed("POST");
      return handleToken(request, resolved, store, signingKey);
    }

    if (pathname === resolved.revocationPath) {
      if (method !== "POST") return methodNotAllowed("POST");
      return handleRevocation(request, store, resolved, signingKey);
    }

    return new Response("Not Found", { status: 404 });
  };
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { allow },
  });
}
