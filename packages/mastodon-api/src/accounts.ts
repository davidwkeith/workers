/**
 * `GET /api/v1/accounts/verify_credentials` — the owner's CredentialAccount.
 * Requires an account-bound token: an app-level (`client_credentials`) token
 * is enough to identify the app, not the user, and Mastodon answers it with
 * `422` here. Live counts come from the phase-2 backend when configured;
 * zeros otherwise (clients render zeros fine).
 */

import { authenticateBearer } from "./auth.js";
import { OWNER_ACCOUNT_ID } from "./config.js";
import {
  credentialAccountEntity,
  decodeRemoteAccountId,
  remoteAccountEntity,
} from "./entities.js";
import { accountRequired, invalidToken, recordNotFound } from "./errors.js";
import type { RouteContext } from "./handler.js";
import { createMastodonStore } from "./store.js";

/** `GET /api/v1/accounts/verify_credentials`. */
export async function handleVerifyAccountCredentials(
  ctx: RouteContext,
): Promise<Response> {
  const token = await authenticateBearer(
    ctx.request,
    createMastodonStore(ctx.env),
  );
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();

  const counts = ctx.config.backend
    ? (await ctx.config.backend.account()).counts
    : { followers: 0, following: 0, statuses: 0 };
  return Response.json(credentialAccountEntity(ctx.config, counts));
}

/**
 * `GET /api/v1/accounts/:id` — the owner (config-derived) or a remote
 * account re-synthesized from its reversibly-encoded id, no backend call
 * (spec/mastodon-client-api.md: "no enumeration... no outbound fetches").
 */
export async function handleGetAccount(
  ctx: RouteContext,
  id: string,
): Promise<Response> {
  const token = await authenticateBearer(
    ctx.request,
    createMastodonStore(ctx.env),
  );
  if (!token) return invalidToken();

  if (id === OWNER_ACCOUNT_ID) {
    const counts = ctx.config.backend
      ? (await ctx.config.backend.account()).counts
      : { followers: 0, following: 0, statuses: 0 };
    // /accounts/:id returns a plain Account, not the verify_credentials
    // CredentialAccount — credentialAccountEntity's extra `source` field is
    // harmless extra data here (Mastodon clients ignore unknown fields), so
    // it's reused rather than duplicating the whole builder for one field.
    return Response.json(credentialAccountEntity(ctx.config, counts));
  }

  const actorIri = decodeRemoteAccountId(id);
  if (!actorIri) return recordNotFound();
  return Response.json(remoteAccountEntity(actorIri));
}
