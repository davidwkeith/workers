/**
 * `@dwk/mf2` — matching a Webmention target against parsed `h-entry` items.
 *
 * @see spec/packages/mf2.md
 * @see spec/packages/webmention.md
 * @packageDocumentation
 */

import type { Jf2Entry } from "./jf2.js";
import { resolveAbsolute } from "./url.js";

/** The recognized received-interaction kinds, in match precedence order. */
export const INTERACTION_KINDS = [
  "reply",
  "repost",
  "like",
  "bookmark",
] as const;

/** A recognized interaction kind. */
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

const ENTRY_FIELD_BY_KIND: Record<InteractionKind, keyof Jf2Entry> = {
  reply: "in-reply-to",
  repost: "repost-of",
  like: "like-of",
  bookmark: "bookmark-of",
};

/** The entry (if any) targeting `targetUrl`, and which "of" property matched. */
export interface MatchedInteraction {
  readonly entry: Jf2Entry;
  readonly kind: InteractionKind;
}

/**
 * Find the entry among `entries` whose `in-reply-to` / `repost-of` /
 * `like-of` / `bookmark-of` resolves to `targetUrl`, and report which
 * property matched. Precedence when an entry implausibly carries more than
 * one matching property: reply > repost > like > bookmark (a reply is the
 * strongest signal). Returns `null` when no entry targets the URL — a bare
 * link mention.
 */
export function matchInteraction(
  entries: readonly Jf2Entry[],
  targetUrl: string,
): MatchedInteraction | null {
  const normalizedTarget = resolveAbsolute(targetUrl, targetUrl);
  if (normalizedTarget === null) return null;

  for (const entry of entries) {
    for (const kind of INTERACTION_KINDS) {
      const value = entry[ENTRY_FIELD_BY_KIND[kind]];
      if (typeof value !== "string") continue;
      // Entry fields are already resolved to absolute URLs by `parseHFeed`.
      if (value === normalizedTarget) {
        return { entry, kind };
      }
    }
  }
  return null;
}
