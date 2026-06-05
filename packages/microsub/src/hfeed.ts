/**
 * `@dwk/microsub` — `h-feed` / `h-entry` microformats parsing.
 *
 * When a followed source is an HTML page rather than a syndication feed, its
 * entries are expressed as [microformats2](https://microformats.org/wiki/h-entry)
 * `h-entry` items (usually inside an `h-feed`). This module extracts them into
 * the same JF2 shape the other formats produce, using the Workers runtime's
 * streaming `HTMLRewriter` rather than a regex or a bundled parser
 * (`HTMLRewriter` is built into the runtime — zero script-size cost; see
 * `spec/non-functional-requirements.md`). Because `HTMLRewriter` is a `workerd`
 * global, this parser is async and exercised under the Workers test pool.
 *
 * It is a pragmatic extractor of the common `h-entry` properties — `u-url`,
 * `p-name`, `e-content`, `dt-published`, `p-author` / nested `h-card`,
 * `u-photo`, `p-category`, `u-in-reply-to`, `u-like-of` — not a full mf2 engine.
 *
 * @packageDocumentation
 */

import type { Jf2Author, Jf2Content, Jf2Entry } from "./jf2";

interface MutableCard {
  name?: string;
  url?: string;
  photo?: string;
}

interface MutableEntry {
  url?: string;
  name?: string;
  content?: string;
  published?: string;
  photo: string[];
  category: string[];
  inReplyTo?: string;
  likeOf?: string;
  author?: MutableCard;
}

type PropFormat = "p" | "u" | "e" | "dt";

interface PropFrame {
  readonly name: string;
  readonly format: PropFormat;
  readonly target: MutableEntry | MutableCard;
  buf: string;
}

function classes(value: string | null): string[] {
  return value === null ? [] : value.trim().split(/\s+/).filter(Boolean);
}

/**
 * HTML void elements have no end tag, so `HTMLRewriter#onEndTag` throws on them.
 * They also carry no text content — a `u-photo` / `dt-published` on one always
 * takes its value from an attribute — so we commit immediately and never
 * register an end-tag handler for them.
 */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** FNV-1a hash (base36), matching {@link ./jf2}'s fallback id derivation. */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
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

function commitEntry(entry: MutableEntry, baseUrl: string): Jf2Entry {
  const url = entry.url ? absolute(entry.url, baseUrl) : undefined;
  const content: Jf2Content | undefined = entry.content
    ? { text: entry.content }
    : undefined;
  const author: Jf2Author | undefined = entry.author
    ? (() => {
        const card: Jf2Author = {
          type: "card",
          ...(entry.author.name ? { name: entry.author.name } : {}),
          ...(entry.author.url
            ? { url: absolute(entry.author.url, baseUrl) }
            : {}),
          ...(entry.author.photo
            ? { photo: absolute(entry.author.photo, baseUrl) }
            : {}),
        };
        return card.name || card.url || card.photo ? card : undefined;
      })()
    : undefined;
  const id = url ?? hash(`${entry.name ?? ""}${entry.content ?? ""}`);

  const out: Record<string, unknown> = { type: "entry", _id: id };
  if (url) out.url = url;
  if (entry.published) out.published = entry.published;
  if (entry.name) out.name = entry.name;
  if (content) out.content = content;
  if (author) out.author = author;
  if (entry.category.length > 0) out.category = entry.category;
  if (entry.photo.length > 0)
    out.photo = entry.photo.map((p) => absolute(p, baseUrl));
  if (entry.inReplyTo) out["in-reply-to"] = absolute(entry.inReplyTo, baseUrl);
  if (entry.likeOf) out["like-of"] = absolute(entry.likeOf, baseUrl);
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

  const entries: Jf2Entry[] = [];
  const entryStack: MutableEntry[] = [];
  const cardStack: MutableCard[] = [];
  const propStack: PropFrame[] = [];

  const top = <T>(arr: T[]): T | undefined => arr[arr.length - 1];

  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      const classList = classes(el.getAttribute("class"));
      const isVoid = VOID_ELEMENTS.has(el.tagName);

      if (classList.includes("h-entry") && !isVoid) {
        const entry: MutableEntry = { photo: [], category: [] };
        entryStack.push(entry);
        el.onEndTag(() => {
          const finished = entryStack.pop();
          if (finished) entries.push(commitEntry(finished, baseUrl));
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
          assignProperty(frame, attr);
          return;
        }
      } else if (prop.format === "dt") {
        const attr = el.getAttribute("datetime") ?? el.getAttribute("value");
        if (attr !== null) {
          assignProperty(frame, attr);
          return;
        }
      }

      // Text-valued property: a void element has no text to capture.
      if (isVoid) return;

      propStack.push(frame);
      el.onEndTag(() => {
        const finished = propStack.pop();
        if (finished) assignProperty(finished, finished.buf.trim());
      });
    },
    text(chunk) {
      const frame = top(propStack);
      if (frame) frame.buf += chunk.text;
    },
  });

  await rewriter.transform(new Response(html)).text();
  return entries;
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
    default:
      break;
  }
}

function isCard(target: MutableEntry | MutableCard): target is MutableCard {
  return !("photo" in target && Array.isArray((target as MutableEntry).photo));
}
