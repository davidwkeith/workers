/**
 * `@dwk/webmention` — received-mention enrichment.
 *
 * During the same asynchronous verification pass that confirms a source links
 * to the target, the source's microformats2 are read once more — via the
 * shared `@dwk/mf2` extractor — to classify the mention (reply / like /
 * repost / bookmark / plain mention) and capture the author, content, and
 * publication time a consumer needs to render it (issue #412). The
 * enrichment is deliberately scoped to the one `h-entry` whose response
 * property (`u-in-reply-to` / `u-like-of` / `u-repost-of` / `u-bookmark-of`)
 * resolves to *our* target; a bare link with no matching entry is a plain
 * `"mention"` with author/content omitted rather than guessed from an
 * unrelated entry on the page.
 *
 * Received content is untrusted UGC: the captured `e-content` HTML is reduced
 * to a small formatting allowlist (`@dwk/mf2`'s `sanitizeHtml` — every
 * attribute stripped except a validated `a[href]`, `rel="ugc nofollow"`
 * forced onto surviving links, closing the SEO/spam-link vector) and
 * truncated, in the Worker, before it ever reaches the inbox store.
 *
 * @see spec/packages/webmention.md
 * @packageDocumentation
 */

import { parseHEntries, sanitizeHtml, type Jf2Entry } from "@dwk/mf2";

import { resolveUrl } from "./html.js";

/** The recognized interaction types for a received mention. */
export const INTERACTION_TYPES = [
  "reply",
  "like",
  "repost",
  "bookmark",
  "mention",
] as const;

/** How a received mention interacts with its target. */
export type InteractionType = (typeof INTERACTION_TYPES)[number];

const INTERACTION_TYPE_SET: ReadonlySet<string> = new Set(INTERACTION_TYPES);

/** Whether `value` is a recognized {@link InteractionType}. */
export function isInteractionType(value: string): value is InteractionType {
  return INTERACTION_TYPE_SET.has(value);
}

/** The mentioning entry's author, from its `p-author` / nested `h-card`. */
export interface MentionAuthor {
  readonly name?: string;
  readonly url?: string;
  readonly photo?: string;
}

/** What the source's microformats say about a verified mention. */
export interface MentionEnrichment {
  readonly interactionType: InteractionType;
  readonly author?: MentionAuthor;
  /** Sanitized, truncated HTML of the mentioning entry's content. */
  readonly content?: string;
  /** The entry's declared `dt-published` value, verbatim, when present. */
  readonly published?: string;
}

/** Cap (text characters) on stored mention content before truncation. */
export const CONTENT_MAX_TEXT_LENGTH = 500;

/**
 * Response-post properties in precedence order — when more than one resolves
 * to the same target on one entry: reply > repost > like > bookmark.
 */
const RESPONSE_PROPERTIES: ReadonlyArray<
  readonly [
    "in-reply-to" | "repost-of" | "like-of" | "bookmark-of",
    InteractionType,
  ]
> = [
  ["in-reply-to", "reply"],
  ["repost-of", "repost"],
  ["like-of", "like"],
  ["bookmark-of", "bookmark"],
];

function classify(
  entry: Jf2Entry,
  normalizedTarget: string,
  baseUrl: string,
): InteractionType | null {
  for (const [property, type] of RESPONSE_PROPERTIES) {
    const value = entry[property];
    if (
      typeof value === "string" &&
      resolveUrl(value, baseUrl) === normalizedTarget
    ) {
      return type;
    }
  }
  return null;
}

/**
 * Extract the enrichment for a verified mention from the source document.
 * Always resolves to an enrichment; a source with no `h-entry` responding to
 * the target — a bare link — is `{ interactionType: "mention" }` with the
 * other fields omitted.
 */
export async function extractEnrichment(
  html: string,
  baseUrl: string,
  target: string,
): Promise<MentionEnrichment> {
  const normalizedTarget = resolveUrl(target, target);
  if (normalizedTarget === null) {
    return { interactionType: "mention" };
  }
  const entries = await parseHEntries(html, baseUrl);
  for (const entry of entries) {
    const interactionType = classify(entry, normalizedTarget, baseUrl);
    if (interactionType === null) continue;

    const card = entry.author;
    const author: MentionAuthor | undefined =
      card && (card.name || card.url || card.photo)
        ? {
            ...(card.name ? { name: card.name } : {}),
            ...(card.url ? { url: card.url } : {}),
            ...(card.photo ? { photo: card.photo } : {}),
          }
        : undefined;

    // `e-content` HTML preferred; a text-only capture (e.g. a `p-summary`
    // fallback) is still routed through the sanitizer, which passes encoded
    // text through and applies the same truncation.
    const raw = entry.content?.html ?? entry.content?.text;
    const content = raw
      ? await sanitizeHtml(raw, {
          baseUrl,
          maxTextLength: CONTENT_MAX_TEXT_LENGTH,
        })
      : "";

    return {
      interactionType,
      ...(author !== undefined ? { author } : {}),
      ...(content !== "" ? { content } : {}),
      ...(entry.published ? { published: entry.published } : {}),
    };
  }
  return { interactionType: "mention" };
}
