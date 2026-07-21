/**
 * `POST /api/v1/apps` — Mastodon's pre-RFC-7591 dynamic app registration, as
 * a thin wire adapter over `@dwk/oauth`'s metadata validation: Mastodon's
 * form/JSON fields in, a Mastodon `Application` entity (with one-time
 * `client_id`/`client_secret`) out. Registration is unauthenticated, matching
 * Mastodon; records are inert until the owner approves an authorization, and
 * the store sweeps never-authorized rows.
 */

import { validateClientMetadata, type ClientRecord } from "@dwk/oauth";

import { authenticateBearer } from "./auth.js";
import { randomToken, sha256Hex } from "./encoding.js";
import { applicationEntity } from "./entities.js";
import { invalidToken, mastodonError } from "./errors.js";
import type { RouteContext } from "./handler.js";
import { createMastodonStore } from "./store.js";

/** Mastodon registration fields, from either a JSON or form-encoded body. */
interface AppRegistration {
  readonly clientName?: string;
  readonly redirectUris: readonly string[];
  readonly scopes: string;
  readonly website?: string;
}

async function readRegistration(request: Request): Promise<AppRegistration> {
  let raw: Record<string, unknown> = {};
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = (await request.json()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON → empty fields; validation reports the 422 below.
    }
  } else {
    try {
      const form = await request.formData();
      for (const [key, value] of form) {
        if (typeof value === "string") raw[key] = value;
      }
    } catch {
      // Malformed body → empty fields, as above.
    }
  }

  // `redirect_uris` arrives as an array (JSON) or a possibly
  // newline-separated string (form and older clients).
  const uris = raw["redirect_uris"];
  const redirectUris = Array.isArray(uris)
    ? uris.filter((uri): uri is string => typeof uri === "string")
    : typeof uris === "string"
      ? uris
          .split("\n")
          .map((uri) => uri.trim())
          .filter(Boolean)
      : [];

  return {
    ...(typeof raw["client_name"] === "string"
      ? { clientName: raw["client_name"] }
      : {}),
    redirectUris,
    scopes:
      typeof raw["scopes"] === "string" && raw["scopes"] !== ""
        ? raw["scopes"]
        : "read",
    ...(typeof raw["website"] === "string" ? { website: raw["website"] } : {}),
  };
}

/** `POST /api/v1/apps`. */
export async function handleCreateApp(ctx: RouteContext): Promise<Response> {
  const registration = await readRegistration(ctx.request);
  if (!registration.clientName) {
    return mastodonError(422, "Validation failed: client_name can't be blank");
  }
  if (registration.redirectUris.length === 0) {
    return mastodonError(
      422,
      "Validation failed: redirect_uris can't be blank",
    );
  }

  // RFC 7591 structural validation via @dwk/oauth: parseable absolute URIs
  // with no fragment. Custom schemes (RFC 8252 native apps) and the oob URN
  // pass; no https-only redirectUriPolicy is applied, by design.
  const metadata: Record<string, unknown> = {
    client_name: registration.clientName,
    redirect_uris: registration.redirectUris,
    scope: registration.scopes,
    ...(registration.website ? { client_uri: registration.website } : {}),
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code", "client_credentials"],
    response_types: ["code"],
  };
  const validated = validateClientMetadata(metadata, {
    saveClient: async () => {},
    grantTypesSupported: ["authorization_code", "client_credentials"],
  });
  if ("error" in validated) {
    return mastodonError(422, `Validation failed: ${validated.description}`);
  }

  const clientId = randomToken();
  const clientSecret = randomToken();
  const record: ClientRecord = {
    clientId,
    clientIdIssuedAt: Math.floor(Date.now() / 1000),
    clientSecret: await sha256Hex(clientSecret),
    metadata: validated.metadata,
  };
  await createMastodonStore(ctx.env).saveClient(record);

  return Response.json(applicationEntity(record, { clientSecret }));
}

/**
 * `GET /api/v1/apps/verify_credentials` — validates any live token (an
 * app-level `client_credentials` token suffices) and returns the token's
 * `Application`, never with credentials.
 */
export async function handleVerifyAppCredentials(
  ctx: RouteContext,
): Promise<Response> {
  const store = createMastodonStore(ctx.env);
  const token = await authenticateBearer(ctx.request, store);
  if (!token) return invalidToken();
  const client = await store.getClient(token.clientId);
  if (!client) return invalidToken();
  return Response.json(applicationEntity(client));
}
