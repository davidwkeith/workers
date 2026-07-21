/**
 * `GET`/`POST /api/v1/markers` — saved read positions. Per-account state,
 * and this deployment has one account, so at most two D1 rows (`home` +
 * `notifications`); clients resume at the owner's read position from day
 * one (spec/mastodon-client-api.md, resolved open question).
 */

import { authenticateBearer } from "./auth.js";
import { markerEntity } from "./entities.js";
import { accountRequired, invalidToken } from "./errors.js";
import type { RouteContext } from "./handler.js";
import { createMastodonStore, type MastodonStore } from "./store.js";

const TIMELINES = ["home", "notifications"] as const;
type Timeline = (typeof TIMELINES)[number];

function isTimeline(value: string): value is Timeline {
  return (TIMELINES as readonly string[]).includes(value);
}

async function requireAccountToken(
  ctx: RouteContext,
  store: MastodonStore,
): Promise<Response | null> {
  const token = await authenticateBearer(ctx.request, store);
  if (!token) return invalidToken();
  if (token.accountId === null) return accountRequired();
  return null;
}

function markersResponse(
  records: readonly {
    timeline: Timeline;
    lastReadId: string;
    version: number;
    updatedAt: number;
  }[],
): Response {
  const body: Record<string, unknown> = {};
  for (const record of records) {
    body[record.timeline] = markerEntity(record);
  }
  return Response.json(body);
}

/** `GET /api/v1/markers?timeline[]=home&timeline[]=notifications`. */
export async function handleGetMarkers(ctx: RouteContext): Promise<Response> {
  const store = createMastodonStore(ctx.env);
  const rejection = await requireAccountToken(ctx, store);
  if (rejection) return rejection;

  const requested = [
    ...ctx.url.searchParams.getAll("timeline[]"),
    ...ctx.url.searchParams.getAll("timeline"),
  ].filter(isTimeline);
  const records = await store.getMarkers(requested);
  return markersResponse(records);
}

/** Timeline → last_read_id pairs from a JSON or Rails-style form body. */
async function readMarkerUpdates(
  request: Request,
): Promise<ReadonlyMap<Timeline, string>> {
  const updates = new Map<Timeline, string>();
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = (await request.json()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (!isTimeline(key)) continue;
          const lastReadId = (value as Record<string, unknown> | null)?.[
            "last_read_id"
          ];
          if (
            typeof lastReadId === "string" ||
            typeof lastReadId === "number"
          ) {
            updates.set(key, String(lastReadId));
          }
        }
      }
    } catch {
      // Empty updates; the response is just {}.
    }
    return updates;
  }
  try {
    const form = await request.formData();
    for (const [key, value] of form) {
      // Rails-style nesting: `home[last_read_id]=101`.
      const match = /^(\w+)\[last_read_id\]$/.exec(key);
      const timeline = match?.[1];
      if (timeline && isTimeline(timeline) && typeof value === "string") {
        updates.set(timeline, value);
      }
    }
  } catch {
    // As above.
  }
  return updates;
}

/** `POST /api/v1/markers`. */
export async function handleSaveMarkers(ctx: RouteContext): Promise<Response> {
  const store = createMastodonStore(ctx.env);
  const rejection = await requireAccountToken(ctx, store);
  if (rejection) return rejection;

  const updates = await readMarkerUpdates(ctx.request);
  const now = Math.floor(Date.now() / 1000);
  const saved = [];
  for (const [timeline, lastReadId] of updates) {
    saved.push(await store.saveMarker(timeline, lastReadId, now));
  }
  return markersResponse(saved);
}
