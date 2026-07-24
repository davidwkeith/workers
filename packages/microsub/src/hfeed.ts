/**
 * `@dwk/microsub` — `h-feed` / `h-entry` microformats parsing.
 *
 * When a followed source is an HTML page rather than a syndication feed, its
 * entries are expressed as [microformats2](https://microformats.org/wiki/h-entry)
 * `h-entry` items (usually inside an `h-feed`). The extractor itself now lives
 * in `@dwk/mf2` (issue #412), where it is shared with `@dwk/webmention`'s
 * received-mention enrichment; this module keeps the package's historical
 * `parseHFeed` name and its `Jf2Entry` return type over that shared
 * implementation. Because the extractor runs on the runtime's streaming
 * `HTMLRewriter`, this parser is async and exercised under the Workers test
 * pool.
 *
 * @packageDocumentation
 */

import { parseHEntries } from "@dwk/mf2";

import type { Jf2Entry } from "./jf2.js";

/**
 * Extract JF2 entries from an HTML document's `h-entry` microformats. Entries
 * are returned in document order. Returns `[]` when the document has none.
 */
export async function parseHFeed(
  html: string,
  baseUrl: string,
): Promise<Jf2Entry[]> {
  return await parseHEntries(html, baseUrl);
}
