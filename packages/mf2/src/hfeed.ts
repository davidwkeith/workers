/**
 * `@dwk/mf2` — `h-feed` / `h-entry` microformats parsing.
 *
 * Extracts embedded microformats2 `h-entry` items (usually inside an
 * `h-feed`) from a fetched HTML page into JF2 shape, using the Workers
 * runtime's streaming `HTMLRewriter` rather than a regex or a bundled parser
 * (`HTMLRewriter` is built into the runtime — zero script-size cost; see
 * `spec/non-functional-requirements.md`). Because `HTMLRewriter` is a
 * `workerd` global, this parser is async and exercised under the Workers test
 * pool.
 *
 * It is a pragmatic extractor of the common `h-entry` properties — `u-url`,
 * `p-name`, `e-content`, `dt-published`, `p-author` / nested `h-card`,
 * `u-photo`, `p-category`, `u-in-reply-to`, `u-like-of`, `u-repost-of`,
 * `u-bookmark-of` — not a full mf2 engine.
 *
 * @packageDocumentation
 */

import { decodeHtmlEntities } from "./entities.js";
import { escapeHtmlAttr, escapeHtmlText } from "./escape.js";
import { fnv1aBase36 } from "./hash.js";
import type { Jf2Author, Jf2Content, Jf2Entry } from "./jf2.js";
import { sanitizeContentHtml } from "./sanitize.js";
import { resolveAbsoluteOrOriginal } from "./url.js";
import { VOID_ELEMENTS } from "./void-elements.js";

interface MutableCard {
  name?: string;
  url?: string;
  photo?: string;
}

interface MutableEntry {
  url?: string;
  name?: string;
  content?: string;
  /** Raw (unsanitized) inner HTML of `e-content`, captured verbatim during the walk. */
  contentRawHtml?: string;
  published?: string;
  photo: string[];
  category: string[];
  inReplyTo?: string;
  likeOf?: string;
  repostOf?: string;
  bookmarkOf?: string;
  author?: MutableCard;
}

type PropFormat = "p" | "u" | "e" | "dt";

interface PropFrame {
  readonly name: string;
  readonly format: PropFormat;
  readonly target: MutableEntry | MutableCard;
  buf: string;
  /**
   * Raw markup accumulator, present only for the `e-content` frame. Nested
   * elements encountered while this frame is active are re-serialized here
   * (see the `element`/`text` handlers below) rather than ignored, since
   * `e-*` means "take this subtree as embedded markup", unlike `p-*`/`u-*`
   * text-valued properties.
   */
  raw?: string[];
}

function classes(value: string | null): string[] {
  return value === null ? [] : value.trim().split(/\s+/).filter(Boolean);
}

/** The first `(p|u|e|dt)-name` microformats class on an element, if any. */
function propertyClass(
  classList: string[],
): { name: string; format: PropFormat } | null {
  for (const cls of classList) {
    const match = /^(p|u|e|dt)-(.+)$/.exec(cls);
    if (match) {
      return { name: match[2] as string, format: match[1] as PropFormat };
    }
  }
  return null;
}

function serializeOpenTag(tag: string, el: Element): string {
  const attrs: string[] = [];
  for (const pair of el.attributes) {
    const [name, value] = pair;
    if (name === undefined || value === undefined) continue;
    attrs.push(`${name}="${escapeHtmlAttr(decodeHtmlEntities(value))}"`);
  }
  const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  return `<${tag}${attrStr}>`;
}

async function commitEntry(
  entry: MutableEntry,
  baseUrl: string,
): Promise<Jf2Entry> {
  const url = entry.url
    ? resolveAbsoluteOrOriginal(entry.url, baseUrl)
    : undefined;
  const html =
    entry.contentRawHtml !== undefined
      ? await sanitizeContentHtml(entry.contentRawHtml, baseUrl)
      : undefined;
  const content: Jf2Content | undefined =
    entry.content || html
      ? {
          ...(html ? { html } : {}),
          ...(entry.content ? { text: entry.content } : {}),
        }
      : undefined;
  const author: Jf2Author | undefined = entry.author
    ? (() => {
        const card: Jf2Author = {
          type: "card",
          ...(entry.author.name ? { name: entry.author.name } : {}),
          ...(entry.author.url
            ? { url: resolveAbsoluteOrOriginal(entry.author.url, baseUrl) }
            : {}),
          ...(entry.author.photo
            ? { photo: resolveAbsoluteOrOriginal(entry.author.photo, baseUrl) }
            : {}),
        };
        return card.name || card.url || card.photo ? card : undefined;
      })()
    : undefined;
  const id = url ?? fnv1aBase36(`${entry.name ?? ""}${entry.content ?? ""}`);

  const out: Record<string, unknown> = { type: "entry", _id: id };
  if (url) out.url = url;
  if (entry.published) out.published = entry.published;
  if (entry.name) out.name = entry.name;
  if (content) out.content = content;
  if (author) out.author = author;
  if (entry.category.length > 0) out.category = entry.category;
  if (entry.photo.length > 0)
    out.photo = entry.photo.map((p) => resolveAbsoluteOrOriginal(p, baseUrl));
  if (entry.inReplyTo)
    out["in-reply-to"] = resolveAbsoluteOrOriginal(entry.inReplyTo, baseUrl);
  if (entry.likeOf)
    out["like-of"] = resolveAbsoluteOrOriginal(entry.likeOf, baseUrl);
  if (entry.repostOf)
    out["repost-of"] = resolveAbsoluteOrOriginal(entry.repostOf, baseUrl);
  if (entry.bookmarkOf)
    out["bookmark-of"] = resolveAbsoluteOrOriginal(entry.bookmarkOf, baseUrl);
  return out as unknown as Jf2Entry;
}

/**
 * Extract JF2 entries from an HTML document's `h-entry` microformats. Entries
 * are returned in document order. Returns `[]` when the document has none.
 */
export async function parseHFeed(
  html: string,
  baseUrl: string,
): Promise<Jf2Entry[]> {
  if (html === "") return [];

  const rawEntries: MutableEntry[] = [];
  const entryStack: MutableEntry[] = [];
  const cardStack: MutableCard[] = [];
  const propStack: PropFrame[] = [];

  const top = <T>(arr: T[]): T | undefined => arr[arr.length - 1];

  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      // Captured up front: `el` (a "content token") is only valid during this
      // synchronous callback, not inside an `onEndTag` closure fired later —
      // every closure below closes over this `tag`/`isVoid`, never `el` itself.
      const tag = el.tagName;
      const isVoid = VOID_ELEMENTS.has(tag);

      // Inside an active `e-content` capture, every descendant is re-serialized
      // as raw markup rather than interpreted as mf2 — nested classes mean
      // nothing to the outer entry once we're inside "embedded content".
      const activeContent = top(propStack);
      if (activeContent?.raw !== undefined) {
        activeContent.raw.push(serializeOpenTag(tag, el));
        if (!isVoid) {
          el.onEndTag(() => {
            activeContent.raw?.push(`</${tag}>`);
          });
        }
        return;
      }

      const classList = classes(el.getAttribute("class"));

      if (classList.includes("h-entry") && !isVoid) {
        const entry: MutableEntry = { photo: [], category: [] };
        entryStack.push(entry);
        el.onEndTag(() => {
          const finished = entryStack.pop();
          if (finished) rawEntries.push(finished);
        });
        return;
      }

      if (classList.includes("h-card") && !isVoid) {
        const card: MutableCard = {};
        const entry = top(entryStack);
        // A bare p-author h-card attaches as the current entry's author.
        if (entry && entry.author === undefined) entry.author = card;
        cardStack.push(card);
        el.onEndTag(() => {
          cardStack.pop();
        });
        return;
      }

      const prop = propertyClass(classList);
      if (prop === null) return;
      const target = top(cardStack) ?? top(entryStack);
      if (target === undefined) return;

      const frame: PropFrame = {
        name: prop.name,
        format: prop.format,
        target,
        buf: "",
        raw: prop.format === "e" && prop.name === "content" ? [] : undefined,
      };

      // u-* and dt-* take their value from an attribute when present; that value
      // is committed immediately, so no text capture (or end tag) is needed.
      if (prop.format === "u") {
        const attr =
          el.getAttribute("href") ??
          el.getAttribute("src") ??
          el.getAttribute("data") ??
          el.getAttribute("poster");
        if (attr !== null) {
          assignProperty(frame, decodeHtmlEntities(attr));
          return;
        }
      } else if (prop.format === "dt") {
        const attr = el.getAttribute("datetime") ?? el.getAttribute("value");
        if (attr !== null) {
          assignProperty(frame, decodeHtmlEntities(attr));
          return;
        }
      }

      // Text-valued property: a void element has no text to capture.
      if (isVoid) return;

      propStack.push(frame);
      el.onEndTag(() => {
        const finished = propStack.pop();
        if (!finished) return;
        assignProperty(finished, finished.buf.trim());
        if (finished.raw !== undefined && !isCard(finished.target)) {
          finished.target.contentRawHtml ??= finished.raw.join("");
        }
      });
    },
    text(chunk) {
      const frame = top(propStack);
      if (!frame || chunk.text === "") return;
      const text = decodeHtmlEntities(chunk.text);
      frame.buf += text;
      if (frame.raw !== undefined) {
        frame.raw.push(escapeHtmlText(text));
      }
    },
  });

  await rewriter.transform(new Response(html)).text();
  return Promise.all(rawEntries.map((entry) => commitEntry(entry, baseUrl)));
}

/** Write a resolved property value onto its target entry or card. */
function assignProperty(frame: PropFrame, value: string): void {
  if (value === "") return;
  const target = frame.target;
  // Card target (author).
  if (isCard(target)) {
    if (frame.name === "name" && target.name === undefined) target.name = value;
    else if (frame.name === "url" && target.url === undefined)
      target.url = value;
    else if (frame.name === "photo" && target.photo === undefined)
      target.photo = value;
    return;
  }
  // Entry target.
  switch (frame.name) {
    case "url":
      target.url ??= value;
      break;
    case "name":
      target.name ??= value;
      break;
    case "content":
      target.content ??= value;
      break;
    case "summary":
      target.content ??= value;
      break;
    case "published":
      target.published ??= value;
      break;
    case "photo":
      target.photo.push(value);
      break;
    case "category":
      target.category.push(value);
      break;
    case "in-reply-to":
      target.inReplyTo ??= value;
      break;
    case "like-of":
      target.likeOf ??= value;
      break;
    case "repost-of":
      target.repostOf ??= value;
      break;
    case "bookmark-of":
      target.bookmarkOf ??= value;
      break;
    default:
      break;
  }
}

function isCard(target: MutableEntry | MutableCard): target is MutableCard {
  return !("photo" in target && Array.isArray((target as MutableEntry).photo));
}
