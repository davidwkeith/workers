/** `GET /api/v1/timelines/home` — the inbox-derived home timeline. */

import { authenticateBearer } from "./auth.js";
import { statusEntity } from "./entities.js";
import { credentialAccountEntity } from "./entities.js";
import { accountRequired, invalidToken } from "./errors.js";
import type { RouteContext } from "./handler.js";
import { buildLinkHeader, pageQuery } from "./pagination.js";
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

  const page = await ctx.config.backend.timeline(
    pageQuery(
      ctx.url,
      { limit: DEFAULT_LIMIT, max: MAX_LIMIT },
      ctx.config.pageSize?.max,
    ),
  );
  const hasOwnerPost = page.entries.some((entry) => entry.source === 1);
  const ownerAccount = hasOwnerPost
    ? credentialAccountEntity(
        ctx.config,
        (await ctx.config.backend.account()).counts,
      )
    : undefined;
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
