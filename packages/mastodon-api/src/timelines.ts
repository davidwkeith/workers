/** `GET /api/v1/timelines/home` — the inbox-derived home timeline. */

import { authenticateBearer } from "./auth.js";
import { statusEntity } from "./entities.js";
import { accountRequired, invalidToken } from "./errors.js";
import type { RouteContext } from "./handler.js";
import { buildLinkHeader } from "./pagination.js";
import { createMastodonStore } from "./store.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 40;

export async function handleHomeTimeline(ctx: RouteContext): Promise<Response> {
  const token = await authenticateBearer(
    ctx.request,
    createMastodonStore(ctx.env),
  );
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();
  if (!ctx.config.backend) return Response.json([]);

  const limit = Math.min(
    Math.max(
      1,
      Number.parseInt(ctx.url.searchParams.get("limit") ?? "", 10) ||
        DEFAULT_LIMIT,
    ),
    ctx.config.pageSize?.max ?? MAX_LIMIT,
  );
  const page = await ctx.config.backend.timeline({
    limit,
    maxId: ctx.url.searchParams.get("max_id") ?? undefined,
    sinceId: ctx.url.searchParams.get("since_id") ?? undefined,
    minId: ctx.url.searchParams.get("min_id") ?? undefined,
  });
  const statuses = page.entries.map((entry) =>
    statusEntity(entry, { baseUrl: ctx.config.baseUrl }),
  );
  const link = buildLinkHeader(ctx.url, {
    firstId: page.entries[0]?.id,
    lastId: page.entries[page.entries.length - 1]?.id,
  });
  const response = Response.json(statuses);
  if (link) response.headers.set("link", link);
  return response;
}
