/**
 * The Mastodon app OAuth flow: `GET /oauth/authorize`, `POST /oauth/token`,
 * and `POST /oauth/revoke`, over the D1 store and `@dwk/oauth` building
 * blocks. Owner authentication + consent is the config-injected
 * `approveAuthorization` hook — this package ships no login UI and stores no
 * owner password (spec/mastodon-client-api.md, Decision 2).
 */

import type { ClientRecord } from "@dwk/oauth";

import { authenticateClient } from "./auth.js";
import type { MastodonAuthorizationRequest } from "./config.js";
import { OWNER_ACCOUNT_ID } from "./config.js";
import { randomToken, sha256Hex, verifyPkceS256 } from "./encoding.js";
import type { RouteContext } from "./handler.js";
import { mastodonError } from "./errors.js";
import { createMastodonStore, type MastodonStore } from "./store.js";

/** RFC 8252 §7.1 out-of-band redirect: render the code instead of redirecting. */
export const OOB_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

const DEFAULT_CODE_LIFETIME_SECONDS = 600;

/** Registered redirect URIs via typed extraction from the metadata bag. */
export function registeredRedirectUris(
  record: ClientRecord,
): readonly string[] {
  const value = record.metadata["redirect_uris"];
  return Array.isArray(value)
    ? value.filter((uri): uri is string => typeof uri === "string")
    : [];
}

/** Registered space-separated scopes (`scope`), defaulting to `read`. */
export function registeredScope(record: ClientRecord): string {
  const value = record.metadata["scope"];
  return typeof value === "string" && value !== "" ? value : "read";
}

function registeredClientName(record: ClientRecord): string {
  const value = record.metadata["client_name"];
  return typeof value === "string" ? value : "";
}

/** Redirect back to the client with OAuth error parameters (RFC 6749 §4.1.2.1). */
function errorRedirect(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): Response {
  const location = new URL(redirectUri);
  location.searchParams.set("error", error);
  location.searchParams.set("error_description", description);
  if (state !== null) location.searchParams.set("state", state);
  return Response.redirect(location.toString(), 302);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The out-of-band success page. The code doubles as the `<title>` because
 * several native clients scrape it from there (the Mastodon behavior).
 */
function oobPage(code: string): Response {
  const safe = escapeHtml(code);
  return new Response(
    `<!doctype html><html><head><title>${safe}</title></head>` +
      `<body><p>Copy this authorization code into your app:</p>` +
      `<p><code>${safe}</code></p></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/** `GET /oauth/authorize`. */
export async function handleAuthorize(ctx: RouteContext): Promise<Response> {
  const params = ctx.url.searchParams;
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state");

  const store = createMastodonStore(ctx.env);
  const client = clientId ? await store.getClient(clientId) : null;
  // Client/redirect failures MUST NOT redirect (RFC 6749 §4.1.2.1) — an
  // unvalidated target would make this an open redirector.
  if (!client) {
    return mastodonError(400, "Unknown client");
  }
  if (!registeredRedirectUris(client).includes(redirectUri)) {
    return mastodonError(400, "Redirect URI is not registered for this client");
  }

  if (params.get("response_type") !== "code") {
    return errorRedirect(
      redirectUri,
      "unsupported_response_type",
      "only `code` is supported",
      state,
    );
  }

  // PKCE is supported, not required (Mastodon ≥4.3): S256 only.
  const codeChallenge = params.get("code_challenge");
  const challengeMethod = params.get("code_challenge_method");
  if (codeChallenge && challengeMethod !== "S256") {
    return errorRedirect(
      redirectUri,
      "invalid_request",
      "code_challenge_method must be S256",
      state,
    );
  }

  const scope = params.get("scope") || registeredScope(client);
  const authorizationRequest: MastodonAuthorizationRequest = {
    clientId,
    clientName: registeredClientName(client),
    redirectUri,
    scope,
    scopes: scope.split(" ").filter(Boolean),
    ...(state !== null ? { state } : {}),
  };

  const decision = await ctx.config.approveAuthorization(
    authorizationRequest,
    ctx.request,
  );
  if (decision instanceof Response) {
    return decision;
  }

  const code = randomToken();
  const now = Math.floor(Date.now() / 1000);
  await store.saveCode({
    code,
    clientId,
    redirectUri,
    scope,
    codeChallenge: codeChallenge ?? null,
    expiresAt:
      now +
      (ctx.config.authorizationCodeLifetimeSeconds ??
        DEFAULT_CODE_LIFETIME_SECONDS),
  });

  if (redirectUri === OOB_REDIRECT_URI) {
    return oobPage(code);
  }
  const location = new URL(redirectUri);
  location.searchParams.set("code", code);
  if (state !== null) location.searchParams.set("state", state);
  return Response.redirect(location.toString(), 302);
}

/** RFC 6749-style token-endpoint error in Mastodon's JSON shape. */
function tokenError(
  status: number,
  error: string,
  description: string,
): Response {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** Normalize a JSON or form-encoded token-request body to search params. */
async function readTokenParams(request: Request): Promise<URLSearchParams> {
  const params = new URLSearchParams();
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = (await request.json()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") params.set(key, value);
        }
      }
    } catch {
      // Empty params; grant validation reports the 400.
    }
    return params;
  }
  try {
    const form = await request.formData();
    for (const [key, value] of form) {
      if (typeof value === "string") params.set(key, value);
    }
  } catch {
    // As above.
  }
  return params;
}

/** Mint, persist (hashed), and serialize an access token. */
async function issueToken(
  store: MastodonStore,
  clientId: string,
  scope: string,
  accountId: string | null,
): Promise<Response> {
  const accessToken = randomToken();
  const createdAt = Math.floor(Date.now() / 1000);
  await store.saveToken({
    tokenHash: await sha256Hex(accessToken),
    clientId,
    scope,
    accountId,
    createdAt,
    revoked: false,
  });
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    scope,
    created_at: createdAt,
  });
}

/** `POST /oauth/token` — `authorization_code` and `client_credentials`. */
export async function handleToken(ctx: RouteContext): Promise<Response> {
  const store = createMastodonStore(ctx.env);
  const params = await readTokenParams(ctx.request);

  const client = await authenticateClient(params, ctx.request.headers, store);
  if (!client) {
    return tokenError(401, "invalid_client", "client authentication failed");
  }

  const grantType = params.get("grant_type") ?? "";
  if (grantType === "client_credentials") {
    // App-level token (some clients fetch one before login): bound to no
    // account — only apps/verify_credentials and public endpoints accept it.
    const scope = params.get("scope") || registeredScope(client);
    return issueToken(store, client.clientId, scope, null);
  }

  if (grantType !== "authorization_code") {
    return tokenError(
      400,
      "unsupported_grant_type",
      "supported grant types: authorization_code, client_credentials",
    );
  }

  const code = params.get("code") ?? "";
  const record = code
    ? await store.redeemCode(code, Math.floor(Date.now() / 1000))
    : null;
  if (!record || record.clientId !== client.clientId) {
    return tokenError(
      400,
      "invalid_grant",
      "authorization code is invalid, expired, or already used",
    );
  }
  if (params.get("redirect_uri") !== record.redirectUri) {
    return tokenError(
      400,
      "invalid_grant",
      "redirect_uri does not match the authorization request",
    );
  }
  if (record.codeChallenge !== null) {
    const verifier = params.get("code_verifier") ?? "";
    if (!verifier || !(await verifyPkceS256(verifier, record.codeChallenge))) {
      return tokenError(400, "invalid_grant", "PKCE verification failed");
    }
  }

  return issueToken(store, client.clientId, record.scope, OWNER_ACCOUNT_ID);
}
