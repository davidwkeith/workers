/** `GET /api/v1/statuses/:id`. */

import { authenticateBearer } from "./auth.js";
import { statusEntity } from "./entities.js";
import { accountRequired, invalidToken, recordNotFound } from "./errors.js";
import type { RouteContext } from "./handler.js";
import { createMastodonStore } from "./store.js";

export async function handleGetStatus(
  ctx: RouteContext,
  id: string,
): Promise<Response> {
  const token = await authenticateBearer(
    ctx.request,
    createMastodonStore(ctx.env),
  );
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();
  if (!ctx.config.backend) return recordNotFound();

  const entry = await ctx.config.backend.entry(id);
  if (!entry) return recordNotFound();
  return Response.json(statusEntity(entry, { baseUrl: ctx.config.baseUrl }));
}
