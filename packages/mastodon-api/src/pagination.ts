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
