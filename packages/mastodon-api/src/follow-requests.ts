/**
 * `GET /api/v1/follow_requests`, `POST /api/v1/follow_requests/:id/authorize`,
 * `POST /api/v1/follow_requests/:id/reject` (#473) — the real, well-known
 * signature Mastodon clients (Tusky, Ivory, Elk) use to manage pending
 * follows. The list is a read (no `allowWrites` gate, matching
 * `handleNotifications`); the two write routes follow the exact
 * `config.allowWrites` + `write` scope pattern `statuses-write.ts` already
 * established for `POST /api/v1/statuses`.
 *
 * @see spec/packages/mastodon-api.md § Write surface
 */

import { authenticateBearer, tokenHasScope } from "./auth.js";
import {
  decodeRemoteAccountId,
  relationshipEntity,
  remoteAccountEntity,
} from "./entities.js";
import {
  accountRequired,
  insufficientScope,
  invalidToken,
  recordNotFound,
} from "./errors.js";
import type { RouteContext } from "./handler.js";
import { createMastodonStore } from "./store.js";

/** `GET /api/v1/follow_requests`. */
export async function handleFollowRequests(
  ctx: RouteContext,
): Promise<Response> {
  const token = await authenticateBearer(
    ctx.request,
    createMastodonStore(ctx.env),
  );
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();
  if (!ctx.config.backend?.followRequests) return Response.json([]);

  const rows = await ctx.config.backend.followRequests();
  const accounts = await Promise.all(
    rows.map(async (row) => {
      const profile = ctx.config.backend?.actorProfile
        ? await ctx.config.backend.actorProfile(row.actor)
        : null;
      return remoteAccountEntity(row.actor, profile);
    }),
  );
  return Response.json(accounts);
}

/** Shared by both write routes; `action` is baked in by the caller. */
export async function handleFollowRequestRespond(
  ctx: RouteContext,
  id: string,
  action: "authorize" | "reject",
): Promise<Response> {
  if (!ctx.config.allowWrites || !ctx.config.backend?.respondToFollowRequest) {
    return recordNotFound();
  }
  const token = await authenticateBearer(
    ctx.request,
    createMastodonStore(ctx.env),
  );
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();
  if (!tokenHasScope(token.scope, "write:follows")) {
    return insufficientScope();
  }
  const actorIri = decodeRemoteAccountId(id);
  if (!actorIri) return recordNotFound();

  await ctx.config.backend.respondToFollowRequest(actorIri, action);
  return Response.json(
    relationshipEntity(actorIri, { followedBy: action === "authorize" }),
  );
}
