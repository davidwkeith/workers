import type { BackendPageQuery } from "./backend.js";

/**
 * Parse a list route's `limit` + cursor params (`max_id`/`since_id`/
 * `min_id`) into a `BackendPageQuery`. `limit` is clamped to
 * `[1, configMax ?? defaults.max]`; the defaults are per-route (Mastodon's
 * own: 20/40 for statuses and timelines, 15/30 for notifications).
 */
export function pageQuery(
  url: URL,
  defaults: { readonly limit: number; readonly max: number },
  configMax?: number,
): BackendPageQuery {
  return {
    limit: Math.min(
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("limit") ?? "", 10) ||
          defaults.limit,
      ),
      configMax ?? defaults.max,
    ),
    maxId: url.searchParams.get("max_id") ?? undefined,
    sinceId: url.searchParams.get("since_id") ?? undefined,
    minId: url.searchParams.get("min_id") ?? undefined,
  };
}

/**
 * RFC 8288 `Link: rel="next"/"prev"` pagination header, Mastodon's own
 * convention: `next` pages backward in time (`max_id` = the last/oldest
 * item shown), `prev` pages forward (`min_id` = the first/newest item
 * shown). Every Mastodon client pages this way.
 */
export function buildLinkHeader(
  requestUrl: URL,
  page: { readonly firstId?: string; readonly lastId?: string },
): string | null {
  if (!page.firstId && !page.lastId) return null;
  const parts: string[] = [];
  if (page.lastId) {
    const next = new URL(requestUrl);
    next.searchParams.delete("min_id");
    next.searchParams.delete("since_id");
    next.searchParams.set("max_id", page.lastId);
    parts.push(`<${next.toString()}>; rel="next"`);
  }
  if (page.firstId) {
    const prev = new URL(requestUrl);
    prev.searchParams.delete("max_id");
    prev.searchParams.set("min_id", page.firstId);
    parts.push(`<${prev.toString()}>; rel="prev"`);
  }
  return parts.join(", ");
}
