/** `GET /api/v1/notifications` — favourite/reblog/mention, plus follow once the backend stores inbound Follows. */

import { authenticateBearer } from "./auth.js";
import { notificationEntity } from "./entities.js";
import { accountRequired, invalidToken } from "./errors.js";
import type { RouteContext } from "./handler.js";
import { buildLinkHeader, pageQuery } from "./pagination.js";
import { createMastodonStore } from "./store.js";

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 30;

export async function handleNotifications(
  ctx: RouteContext,
): Promise<Response> {
  const token = await authenticateBearer(
    ctx.request,
    createMastodonStore(ctx.env),
  );
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();
  if (!ctx.config.backend) return Response.json([]);

  const page = await ctx.config.backend.notifications(
    pageQuery(
      ctx.url,
      { limit: DEFAULT_LIMIT, max: MAX_LIMIT },
      ctx.config.pageSize?.max,
    ),
  );
  const notifications = page.entries
    .map((entry) => notificationEntity(entry, { baseUrl: ctx.config.baseUrl }))
    .filter((n): n is Record<string, unknown> => n !== null);
  const link = buildLinkHeader(ctx.url, {
    firstId: page.entries[0]?.id,
    lastId: page.entries[page.entries.length - 1]?.id,
  });
  const response = Response.json(notifications);
  if (link) response.headers.set("link", link);
  return response;
}
