/**
 * `@dwk/mf2` — `h-entry` / `h-card` microformats extraction.
 *
 * Extracts a document's [microformats2](https://microformats.org/wiki/h-entry)
 * `h-entry` items (usually inside an `h-feed`) into JF2 `entry` objects, using
 * the runtime's built-in streaming `HTMLRewriter` rather than a regex or a
 * bundled parser (zero script-size cost; see
 * `spec/non-functional-requirements.md`). Because `HTMLRewriter` is a runtime
 * global, this parser is async and exercised under the Workers test pool.
 *
 * It is a pragmatic extractor of the common `h-entry` properties — `u-url`,
 * `p-name`, `e-content` (plain text **and** inner HTML), `dt-published`,
 * `p-author` / nested `h-card`, `u-photo`, `p-category`, and the
 * response-post URLs `u-in-reply-to`, `u-like-of`, `u-repost-of`,
 * `u-bookmark-of` — not a full mf2 engine. Extracted from `@dwk/microsub`'s
 * `hfeed.ts` so `@dwk/webmention` can share it (issue #412).
 *
 * @packageDocumentation
 */

import { decodeEntities } from "./entities.js";
import { fnv1aBase36 } from "./jf2.js";
import type { Jf2Author, Jf2Content, Jf2Entry } from "./jf2.js";
import { VOID_ELEMENTS } from "./void-elements.js";

interface MutableCard {
  name?: string;
  url?: string;
  photo?: string;
}

interface MutableEntry {
  url?: string;
  name?: string;
  /** `e-content` text (or `p-summary` fallback). */
  content?: string;
  /** `e-content` inner HTML, reconstructed from the stream. Unsanitized. */
  contentHtml?: string;
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
  /** Reconstructed inner HTML — only accumulated for `e-*` frames. */
  html: string;
}

/**
 * Cap on the inner HTML captured per `e-*` property. The extractor takes
 * arbitrary (attacker-supplied) pages, so an enormous `e-content` must not
 * balloon memory — consumers truncate far below this anyway.
 */
const MAX_CAPTURED_HTML = 65536;

function classes(value: string | null): string[] {
  return value === null ? [] : value.trim().split(/\s+/).filter(Boolean);
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
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

/** Encode a decoded attribute value for serialization. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

/**
 * Serialize an element's start tag. Attribute values arrive raw (entities as
 * written), so they are decoded before re-encoding — escaping the raw value
 * directly would double-escape `&amp;` into `&amp;amp;`.
 */
function serializeStartTag(el: Element, tagName: string): string {
  let out = `<${tagName}`;
  for (const [name, value] of el.attributes) {
    out += ` ${name}="${escapeAttribute(decodeEntities(value ?? ""))}"`;
  }
  return out + ">";
}

function commitEntry(entry: MutableEntry, baseUrl: string): Jf2Entry {
  const url = entry.url ? absolute(entry.url, baseUrl) : undefined;
  const content: Jf2Content | undefined =
    entry.content || entry.contentHtml
      ? {
          ...(entry.contentHtml ? { html: entry.contentHtml } : {}),
          ...(entry.content ? { text: entry.content } : {}),
        }
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
  const id = url ?? fnv1aBase36(`${entry.name ?? ""}${entry.content ?? ""}`);

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
  if (entry.repostOf) out["repost-of"] = absolute(entry.repostOf, baseUrl);
  if (entry.bookmarkOf)
    out["bookmark-of"] = absolute(entry.bookmarkOf, baseUrl);
  return out as unknown as Jf2Entry;
}

/**
 * Extract JF2 entries from an HTML document's `h-entry` microformats. Entries
 * are returned in document order. Returns `[]` when the document has none.
 */
export async function parseHEntries(
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
      const tagName = el.tagName;
      const isVoid = VOID_ELEMENTS.has(tagName);
      // Deferred work for this element's end tag, registered once at the end
      // (`HTMLRewriter` supports a single end-tag handler per element, and
      // void elements have no end tag at all).
      const endActions: Array<() => void> = [];

      // Capture this element's markup into any `e-*` property currently being
      // collected. The element that *opens* a frame is not part of its own
      // inner HTML, so this runs before any frame is pushed below.
      const capturing = propStack.filter(
        (frame) =>
          frame.format === "e" && frame.html.length < MAX_CAPTURED_HTML,
      );
      if (capturing.length > 0) {
        const start = serializeStartTag(el, tagName);
        for (const frame of capturing) frame.html += start;
        if (!isVoid) {
          endActions.push(() => {
            for (const frame of capturing) {
              if (frame.html.length < MAX_CAPTURED_HTML) {
                frame.html += `</${tagName}>`;
              }
            }
          });
        }
      }

      // Root/property scopes this element opens (early-return style, so the
      // precedence between h-entry / h-card / property classes stays exactly
      // as it was in `@dwk/microsub`'s original extractor).
      const openScopes = (): void => {
        if (classList.includes("h-entry") && !isVoid) {
          const entry: MutableEntry = { photo: [], category: [] };
          entryStack.push(entry);
          endActions.push(() => {
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
          endActions.push(() => {
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
          html: "",
        };

        // u-* and dt-* take their value from an attribute when present; that
        // value is committed immediately, so no text capture (or end tag) is
        // needed. Attribute values arrive raw, so they are decoded here — a
        // `u-in-reply-to` href of `…?a=1&amp;b=2` must yield `…?a=1&b=2`.
        if (prop.format === "u") {
          const attr =
            el.getAttribute("href") ??
            el.getAttribute("src") ??
            el.getAttribute("data") ??
            el.getAttribute("poster");
          if (attr !== null) {
            assignProperty(frame, decodeEntities(attr));
            return;
          }
        } else if (prop.format === "dt") {
          const attr = el.getAttribute("datetime") ?? el.getAttribute("value");
          if (attr !== null) {
            assignProperty(frame, decodeEntities(attr));
            return;
          }
        }

        // Text-valued property: a void element has no text to capture.
        if (isVoid) return;

        propStack.push(frame);
        endActions.push(() => {
          const finished = propStack.pop();
          if (finished) commitFrame(finished);
        });
      };
      openScopes();

      if (endActions.length > 0) {
        el.onEndTag(() => {
          for (const action of endActions) action();
        });
      }
    },
    text(chunk) {
      const frame = top(propStack);
      if (frame) frame.buf += chunk.text;
      if (chunk.text === "") return;
      // Text chunks arrive as written (entities are NOT decoded), so they are
      // appended to the HTML capture verbatim — already valid HTML text.
      for (const open of propStack) {
        if (open.format === "e" && open.html.length < MAX_CAPTURED_HTML) {
          open.html += chunk.text;
        }
      }
    },
  });

  await rewriter.transform(new Response(html)).text();
  return entries;
}

/**
 * Commit a text-collecting frame's value(s) onto its target at its end tag.
 * Text chunks accrue raw; decoding happens once here, on the whole buffer, so
 * an entity split across two chunks still decodes. The HTML capture stays
 * encoded as written — it is HTML, not plain text.
 */
function commitFrame(frame: PropFrame): void {
  const text = decodeEntities(frame.buf).trim();
  // `e-content` commits both the text and the captured inner HTML; the first
  // content value on an entry wins, matching the plain-text properties below.
  if (
    frame.format === "e" &&
    frame.name === "content" &&
    !isCard(frame.target)
  ) {
    const entry = frame.target;
    if (entry.content === undefined && entry.contentHtml === undefined) {
      const html = frame.html.trim();
      if (text !== "") entry.content = text;
      if (html !== "") entry.contentHtml = html;
    }
    return;
  }
  assignProperty(frame, text);
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
