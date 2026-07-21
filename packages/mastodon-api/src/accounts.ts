/**
 * `GET /api/v1/accounts/verify_credentials` — the owner's CredentialAccount.
 * Requires an account-bound token: an app-level (`client_credentials`) token
 * is enough to identify the app, not the user, and Mastodon answers it with
 * `422` here. Live counts come from the phase-2 backend when configured;
 * zeros otherwise (clients render zeros fine).
 */

import { authenticateBearer } from "./auth.js";
import { credentialAccountEntity } from "./entities.js";
import { accountRequired, invalidToken } from "./errors.js";
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
