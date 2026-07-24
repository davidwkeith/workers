/**
 * `GET /authorize` — the authorization endpoint. Validates the request,
 * delegates owner authentication + consent to the injected approval hook, and
 * on approval mints a single-use, PKCE-bound authorization code and redirects
 * back to the client.
 *
 * Client/redirect validation failures are direct `400`s (never a redirect —
 * an unvalidated `redirect_uri` must not be used as an error sink, RFC 6749
 * §4.1.2.1). Post-validation errors redirect back with `error=`.
 *
 * @packageDocumentation
 */

import type { ResolvedSolidOidcConfig } from "./config.js";
import { randomToken } from "./encoding.js";
import { oauthError } from "./http.js";
import { isValidChallenge } from "./pkce.js";
import type { CodeStore } from "./store.js";

/** Parse an absolute http(s) URL, or `null`. */
function absoluteUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Redirect back to the client with query params appended. */
function redirect(redirectUri: URL, params: Record<string, string>): Response {
  const target = new URL(redirectUri.toString());
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), "cache-control": "no-store" },
  });
}

export async function handleAuthorize(
  request: Request,
  config: ResolvedSolidOidcConfig,
  codes: CodeStore,
): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams;

  // Client + redirect are validated first; failures are direct 400s.
  const clientId = q.get("client_id");
  if (!clientId || absoluteUrl(clientId) === null) {
    return oauthError(
      400,
      "invalid_request",
      "client_id must be an absolute URL (a Solid client identifier)",
    );
  }
  const redirectUri = absoluteUrl(q.get("redirect_uri"));
  if (redirectUri === null) {
    return oauthError(
      400,
      "invalid_request",
      "redirect_uri must be an absolute http(s) URL",
    );
  }
  // NOTE: v1 does not yet fetch the client_id document to confirm this
  // redirect_uri is registered there (RFC 9449 / Solid-OIDC client identifiers);
  // the owner consent hook is the gate. Client-doc redirect validation is a
  // documented follow-up hardening.

  const state = q.get("state") ?? undefined;
  const responseType = q.get("response_type");
  if (responseType !== "code") {
    return redirect(redirectUri, {
      error: "unsupported_response_type",
      ...(state ? { state } : {}),
    });
  }
  const codeChallenge = q.get("code_challenge");
  const challengeMethod = q.get("code_challenge_method");
  if (!codeChallenge || challengeMethod !== "S256") {
    return redirect(redirectUri, {
      error: "invalid_request",
      error_description: "PKCE with code_challenge_method=S256 is required",
      ...(state ? { state } : {}),
    });
  }
  if (!isValidChallenge(codeChallenge)) {
    return redirect(redirectUri, {
      error: "invalid_request",
      error_description: "malformed code_challenge",
      ...(state ? { state } : {}),
    });
  }

  const scope = q.get("scope") ?? "openid webid";
  const nonce = q.get("nonce") ?? undefined;

  // Owner authentication + consent.
  const decision = await config.approveAuthorization(
    {
      clientId,
      redirectUri: redirectUri.toString(),
      scope,
      ...(state ? { state } : {}),
      ...(nonce ? { nonce } : {}),
      codeChallenge,
    },
    request,
  );
  if (decision instanceof Response) return decision;

  // Approved: mint a single-use code bound to the request.
  const code = randomToken();
  const grantedScope = decision.scope ?? scope;
  await codes.save(code, {
    clientId,
    redirectUri: redirectUri.toString(),
    scope: grantedScope,
    webid: decision.webid,
    codeChallenge,
    nonce: nonce ?? null,
    expiresAt:
      Math.floor(config.now() / 1000) + config.authorizationCodeLifetimeSeconds,
  });
  return redirect(redirectUri, { code, ...(state ? { state } : {}) });
}
