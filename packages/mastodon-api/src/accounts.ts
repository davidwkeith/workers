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
  statusEntity,
} from "./entities.js";
import { accountRequired, invalidToken, recordNotFound } from "./errors.js";
import type { RouteContext } from "./handler.js";
import { buildLinkHeader } from "./pagination.js";
import { createMastodonStore } from "./store.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;

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
  const profile = ctx.config.backend?.actorProfile
    ? await ctx.config.backend.actorProfile(actorIri)
    : null;
  return Response.json(remoteAccountEntity(actorIri, profile));
}

/**
 * `GET /api/v1/accounts/:id/statuses` — the owner's own posts (the outbox
 * rows the home timeline already merges), newest-first with the standard
 * `Link` pagination. Remote account ids answer a valid-but-empty page: this
 * deployment stores remote actors' profiles, never their status history
 * (spec/mastodon-client-api.md: "no enumeration... no outbound fetches").
 */
export async function handleAccountStatuses(
  ctx: RouteContext,
  id: string,
): Promise<Response> {
  const token = await authenticateBearer(
    ctx.request,
    createMastodonStore(ctx.env),
  );
  if (!token) return invalidToken();

  if (id !== OWNER_ACCOUNT_ID) {
    if (!decodeRemoteAccountId(id)) return recordNotFound();
    return Response.json([]);
  }
  const backend = ctx.config.backend;
  if (!backend?.ownStatuses) return Response.json([]);

  const limit = Math.min(
    Math.max(
      1,
      Number.parseInt(ctx.url.searchParams.get("limit") ?? "", 10) ||
        DEFAULT_LIMIT,
    ),
    ctx.config.pageSize?.max ?? MAX_LIMIT,
  );
  const page = await backend.ownStatuses({
    limit,
    maxId: ctx.url.searchParams.get("max_id") ?? undefined,
    sinceId: ctx.url.searchParams.get("since_id") ?? undefined,
    minId: ctx.url.searchParams.get("min_id") ?? undefined,
  });
  const ownerAccount = credentialAccountEntity(
    ctx.config,
    (await backend.account()).counts,
  );
  const statuses = page.entries.map((entry) =>
    statusEntity(entry, { baseUrl: ctx.config.baseUrl, ownerAccount }),
  );
  const link = buildLinkHeader(ctx.url, {
    firstId: page.entries[0]?.id,
    lastId: page.entries[page.entries.length - 1]?.id,
  });
  const response = Response.json(statuses);
  if (link) response.headers.set("link", link);
  return response;
}

/**
 * `GET /api/v1/accounts/:id/{followers,following,featured_tags}` — the
 * valid-but-empty answer (Decision 3): clients render an empty list, and the
 * follower/following IRIs are not exposed through the client API in v1.
 */
export async function handleAccountCompanionStub(
  ctx: RouteContext,
  id: string,
): Promise<Response> {
  const token = await authenticateBearer(
    ctx.request,
    createMastodonStore(ctx.env),
  );
  if (!token) return invalidToken();
  if (id !== OWNER_ACCOUNT_ID && !decodeRemoteAccountId(id)) {
    return recordNotFound();
  }
  return Response.json([]);
}
