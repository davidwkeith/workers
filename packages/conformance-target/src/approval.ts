/**
 * IndieAuth authentication + consent for the conformance identity. The library
 * owns the protocol, and per the IndieAuth spec `POST /authorize` is the
 * profile-URL redemption grant — so consent submission lives on the
 * deployer-owned `POST /consent` mount instead:
 *
 * - `GET /authorize` → `approveAuthorization` renders the consent form (which
 *   posts to `/consent`), or — when the request carries a valid
 *   `consent_sig`/`consent_exp` pair minted by `/consent` — approves outright.
 * - `POST /consent` (`createConsent`) checks the password (the
 *   CONFORMANCE_PASSWORD secret) and 303-redirects back to `GET /authorize`
 *   with the signed consent token appended.
 *
 * Good enough for a test identity, not a real IdP: the HMAC reuses
 * TOKEN_SIGNING_KEY (domain-separated by the "consent:v1" prefix) and replay
 * within the 5-minute TTL is acceptable.
 */

import type { IndieAuthConfig } from "@dwk/indieauth";

import type { ConformanceEnv } from "./config.js";
import { timingSafeEqual } from "./timing-safe-equal.js";

/** Consent-token lifetime: 5 minutes. */
const CONSENT_TTL_MS = 300_000;

/** Params owned by the consent exchange; never echoed back into the form or redirect. */
const CONSENT_PARAMS = ["consent_sig", "consent_exp", "password"];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * HMAC-SHA256 over the fields the authorization decision depends on, keyed by
 * TOKEN_SIGNING_KEY and domain-separated by the `consent:v1` prefix so a
 * consent token can never be confused with anything else signed by that key.
 */
async function signConsent(
  key: string,
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  exp: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = `consent:v1\n${clientId}\n${redirectUri}\n${state}\n${codeChallenge}\n${exp}`;
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(message),
  );
  return base64url(sig);
}

/** Echo the authorization request back as hidden fields on the consent form. */
function consentForm(httpRequest: Request): string {
  const params = new URL(httpRequest.url).searchParams;
  const hidden = [...params.entries()]
    .filter(([name]) => !CONSENT_PARAMS.includes(name))
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("\n");
  const clientId = escapeHtml(params.get("client_id") ?? "unknown client");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorize</title></head>
<body>
<h1>Authorize ${clientId}</h1>
<form method="post" action="/consent">
${hidden}
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Approve</button>
</form>
</body>
</html>
`;
}

/**
 * The consent hook `createIndieAuth` calls on `GET /authorize` (the library
 * never calls it on POST). A valid, unexpired signed consent token approves
 * the request; anything else renders the consent form. Never checks a
 * password here — that happens only on `POST /consent`.
 */
export function approveAuthorization(
  env: ConformanceEnv,
): IndieAuthConfig["approveAuthorization"] {
  return async (request, httpRequest) => {
    const params = new URL(httpRequest.url).searchParams;
    const sig = params.get("consent_sig");
    const exp = params.get("consent_exp");
    if (sig !== null && exp !== null) {
      // Recompute over the *validated* AuthorizationRequest fields, not the
      // raw query, so the signature vouches for exactly what will be granted.
      // Replay within the TTL is accepted — fine for a conformance-test
      // identity.
      const expected = await signConsent(
        env.TOKEN_SIGNING_KEY,
        request.clientId,
        request.redirectUri,
        request.state,
        request.codeChallenge,
        exp,
      );
      if (timingSafeEqual(sig, expected) && Number(exp) > Date.now()) {
        return { me: `${env.BASE_URL}/` };
      }
    }
    return new Response(consentForm(httpRequest), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
}

/**
 * `POST /consent`: validate the password, then 303 back to `GET /authorize`
 * with the original authorization params plus the signed consent token.
 */
export function createConsent(
  env: ConformanceEnv,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method.toUpperCase() !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    // Refuse outright when the secret is unset — an empty or missing
    // password must never authenticate.
    const password = form.get("password");
    if (
      !env.CONFORMANCE_PASSWORD ||
      typeof password !== "string" ||
      !timingSafeEqual(password, env.CONFORMANCE_PASSWORD)
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const params = new URLSearchParams();
    for (const [name, value] of form) {
      if (typeof value !== "string") continue;
      if (CONSENT_PARAMS.includes(name)) continue;
      params.append(name, value);
    }
    const exp = String(Date.now() + CONSENT_TTL_MS);
    const sig = await signConsent(
      env.TOKEN_SIGNING_KEY,
      params.get("client_id") ?? "",
      params.get("redirect_uri") ?? "",
      params.get("state") ?? "",
      params.get("code_challenge") ?? "",
      exp,
    );
    params.set("consent_exp", exp);
    params.set("consent_sig", sig);
    return new Response(null, {
      status: 303,
      headers: { location: `${env.BASE_URL}/authorize?${params}` },
    });
  };
}
