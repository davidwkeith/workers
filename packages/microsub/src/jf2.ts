/**
 * `@dwk/microsub` — feed → JF2 normalisation.
 *
 * Microsub serves a single normalised timeline regardless of a source's wire
 * format. This module turns the four feed formats a reader meets — JSON Feed,
 * Atom, RSS 2.0, and `h-feed` microformats (the last parsed upstream in
 * {@link ./hfeed}) — into [JF2](https://jf2.spec.indieweb.org/) `entry` objects.
 *
 * Everything here is **pure**: a feed body (and the format-sniffing on its
 * content type) in, an array of JF2 entries out, each carrying a stable `_id`
 * derived from the source's own identifier so the store can dedupe across polls.
 * The XML formats go through the dependency-free reader in {@link ./xml}.
 *
 * @packageDocumentation
 */

import {
  child,
  children,
  childText,
  parseXml,
  text,
  type XmlElement,
} from "./xml.js";

/** A JF2 author card. */
export interface Jf2Author {
  readonly type: "card";
  readonly name?: string;
  readonly url?: string;
  readonly photo?: string;
}

/** Structured JF2 content (`html` and/or its plain-text rendering). */
export interface Jf2Content {
  readonly html?: string;
  readonly text?: string;
}

/** A normalised JF2 timeline entry. */
export interface Jf2Entry {
  readonly type: "entry";
  /**
   * Stable per-entry identifier, derived from the source's own id/guid/url. The
   * store keys timeline rows on this so re-polling a feed does not duplicate
   * entries.
   */
  readonly _id: string;
  readonly url?: string;
  readonly published?: string;
  readonly name?: string;
  readonly summary?: string;
  readonly content?: Jf2Content;
  readonly author?: Jf2Author;
  readonly category?: readonly string[];
  readonly photo?: readonly string[];
  readonly "in-reply-to"?: string;
  readonly "like-of"?: string;
  /** Read flag, attached by the store on read (never by the parser). */
  readonly _is_read?: boolean;
}

/** Resolve `href` against `base`, returning an absolute URL or the input. */
function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/**
 * Derive a stable entry id from the best available identifier. A feed-supplied
 * id/guid/url is used verbatim; otherwise a short hash of the entry's content
 * keeps re-polls from duplicating an entry that has no stable id of its own.
 */
function entryId(candidate: string | undefined, fallback: string): string {
  const basis =
    candidate && candidate.trim() !== "" ? candidate.trim() : fallback;
  return basis;
}

/** A small, stable non-cryptographic hash (FNV-1a) rendered as base36. */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function defined<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

// --- JSON Feed --------------------------------------------------------------

interface JsonFeedItem {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  content_html?: unknown;
  content_text?: unknown;
  summary?: unknown;
  date_published?: unknown;
  tags?: unknown;
  image?: unknown;
  banner_image?: unknown;
  authors?: unknown;
  author?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function jsonFeedAuthor(
  item: JsonFeedItem,
  feedAuthor?: Jf2Author,
): Jf2Author | undefined {
  const authors = Array.isArray(item.authors) ? item.authors : undefined;
  const raw =
    (authors?.[0] as Record<string, unknown> | undefined) ??
    (item.author as Record<string, unknown> | undefined);
  if (raw && typeof raw === "object") {
    const card = defined({
      type: "card" as const,
      name: str(raw.name),
      url: str(raw.url),
      photo: str(raw.avatar),
    });
    if (card.name || card.url || card.photo) return card;
  }
  return feedAuthor;
}

function parseJsonFeed(body: string, baseUrl: string): Jf2Entry[] {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return [];
  }
  const items = Array.isArray(doc.items) ? doc.items : [];
  const feedAuthorRaw =
    (Array.isArray(doc.authors)
      ? (doc.authors[0] as Record<string, unknown>)
      : undefined) ?? (doc.author as Record<string, unknown> | undefined);
  const feedAuthor =
    feedAuthorRaw && typeof feedAuthorRaw === "object"
      ? defined({
          type: "card" as const,
          name: str(feedAuthorRaw.name),
          url: str(feedAuthorRaw.url),
          photo: str(feedAuthorRaw.avatar),
        })
      : undefined;

  const entries: Jf2Entry[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as JsonFeedItem;
    const url = str(item.url);
    const html = str(item.content_html);
    const textContent = str(item.content_text);
    const content =
      html || textContent ? defined({ html, text: textContent }) : undefined;
    const tags = Array.isArray(item.tags)
      ? item.tags.filter((t): t is string => typeof t === "string")
      : undefined;
    const image = str(item.image) ?? str(item.banner_image);
    const id = entryId(
      str(item.id) ?? url,
      hash(`${textContent ?? html ?? str(item.title) ?? ""}${url ?? ""}`),
    );
    entries.push(
      defined({
        type: "entry" as const,
        _id: id,
        url: url ? absolute(url, baseUrl) : undefined,
        published: str(item.date_published),
        name: str(item.title),
        summary: str(item.summary),
        content,
        author: jsonFeedAuthor(item, feedAuthor),
        category: tags && tags.length > 0 ? tags : undefined,
        photo: image ? [absolute(image, baseUrl)] : undefined,
      }) as Jf2Entry,
    );
  }
  return entries;
}

// --- Atom -------------------------------------------------------------------

/** The `href` of the best Atom `<link>`: prefer `rel="alternate"`, else first. */
function atomLink(entry: XmlElement, baseUrl: string): string | undefined {
  const links = children(entry, "link");
  let fallback: string | undefined;
  for (const link of links) {
    const href = link.attrs.href;
    if (!href) continue;
    const rel = link.attrs.rel ?? "alternate";
    if (rel === "alternate") return absolute(href, baseUrl);
    fallback ??= absolute(href, baseUrl);
  }
  return fallback;
}

function atomAuthor(scope: XmlElement, baseUrl: string): Jf2Author | undefined {
  const author = child(scope, "author");
  if (author === null) return undefined;
  const name = childText(author, "name");
  const uri = childText(author, "uri");
  const card = defined({
    type: "card" as const,
    name: name || undefined,
    url: uri ? absolute(uri, baseUrl) : undefined,
  });
  return card.name || card.url ? card : undefined;
}

function parseAtom(feed: XmlElement, baseUrl: string): Jf2Entry[] {
  const feedAuthor = atomAuthor(feed, baseUrl);
  const entries: Jf2Entry[] = [];
  for (const entry of children(feed, "entry")) {
    const url = atomLink(entry, baseUrl);
    const contentEl = child(entry, "content");
    const summary = childText(entry, "summary");
    const contentHtml = contentEl ? text(contentEl) : "";
    const content = contentHtml
      ? { html: contentHtml }
      : summary
        ? { html: summary }
        : undefined;
    const categories = children(entry, "category")
      .map((c) => c.attrs.term ?? "")
      .filter((t) => t !== "");
    const id = entryId(
      childText(entry, "id") || url,
      hash(`${childText(entry, "title")}${url ?? ""}`),
    );
    entries.push(
      defined({
        type: "entry" as const,
        _id: id,
        url,
        published:
          childText(entry, "published") ||
          childText(entry, "updated") ||
          undefined,
        name: childText(entry, "title") || undefined,
        summary: summary || undefined,
        content,
        author: atomAuthor(entry, baseUrl) ?? feedAuthor,
        category: categories.length > 0 ? categories : undefined,
      }) as Jf2Entry,
    );
  }
  return entries;
}

// --- RSS 2.0 / RDF ----------------------------------------------------------

function rssAuthor(item: XmlElement): Jf2Author | undefined {
  const creator = childText(item, "dc:creator") || childText(item, "author");
  if (creator === "") return undefined;
  // RSS `<author>` is an email; `dc:creator` is a display name. Either way we
  // surface the string as the card name (an email is the best we have).
  return { type: "card", name: creator };
}

function parseRss(root: XmlElement, baseUrl: string): Jf2Entry[] {
  // RSS 2.0 nests items under `<channel>`; RDF (RSS 1.0) lists them at the root.
  const channel = child(root, "channel");
  const scope = channel ?? root;
  const items = [...children(scope, "item"), ...children(root, "item")];
  const seen = new Set<XmlElement>();
  const entries: Jf2Entry[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    const link = childText(item, "link");
    const guidEl = child(item, "guid");
    const guid = guidEl ? text(guidEl) : "";
    const url = link
      ? absolute(link, baseUrl)
      : guid
        ? absolute(guid, baseUrl)
        : undefined;
    const encoded = childText(item, "content:encoded");
    const description = childText(item, "description");
    const body = encoded || description;
    const content = body ? { html: body } : undefined;
    const categories = children(item, "category")
      .map((c) => text(c))
      .filter((t) => t !== "");
    const id = entryId(
      guid || link,
      hash(`${childText(item, "title")}${url ?? ""}`),
    );
    entries.push(
      defined({
        type: "entry" as const,
        _id: id,
        url,
        published:
          childText(item, "pubdate") || childText(item, "dc:date") || undefined,
        name: childText(item, "title") || undefined,
        summary: encoded && description ? description : undefined,
        content,
        author: rssAuthor(item),
        category: categories.length > 0 ? categories : undefined,
      }) as Jf2Entry,
    );
  }
  return entries;
}

// --- Ordering ---------------------------------------------------------------

/** Parse an entry's `published` to epoch milliseconds, or `null`. */
function publishedMs(entry: Jf2Entry): number | null {
  if (!entry.published) return null;
  const ms = Date.parse(entry.published);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Order a feed's entries oldest-first for insertion, so the newest entry is
 * appended last and receives the highest paging `seq`.
 *
 * When the entries carry dates they are sorted chronologically (a feed's own
 * order is not trusted). When none do — some `h-feed` pages — the feed is
 * assumed newest-first and simply reversed. The sort is stable, so undated
 * entries keep their relative position among dated ones.
 */
export function orderEntriesForInsert(
  entries: readonly Jf2Entry[],
): Jf2Entry[] {
  const anyDated = entries.some((entry) => publishedMs(entry) !== null);
  if (!anyDated) return [...entries].reverse();
  return entries
    .map((entry, index) => ({ entry, index, ms: publishedMs(entry) }))
    .sort((a, b) => {
      // Undated entries sort as oldest (lowest seq); ties keep feed order.
      const am = a.ms ?? Number.NEGATIVE_INFINITY;
      const bm = b.ms ?? Number.NEGATIVE_INFINITY;
      return am === bm ? a.index - b.index : am - bm;
    })
    .map((wrapped) => wrapped.entry);
}

// --- Dispatch ---------------------------------------------------------------

/** Whether a content type / body looks like JSON Feed. */
function looksLikeJson(contentType: string, body: string): boolean {
  if (/\bjson\b/i.test(contentType)) return true;
  const trimmed = body.trimStart();
  return (
    trimmed.startsWith("{") &&
    /"version"\s*:\s*"https:\/\/jsonfeed\.org/.test(trimmed)
  );
}

/**
 * Parse a fetched feed body into JF2 entries, sniffing the format from the
 * content type and the document root. Returns `[]` for an unrecognised or
 * unparseable body (the caller treats an empty parse as "nothing new").
 *
 * `h-feed` HTML is **not** handled here — it needs the runtime's `HTMLRewriter`
 * and lives in {@link ./hfeed}; this module is pure and runtime-free.
 */
export function parseFeed(
  body: string,
  contentType: string,
  baseUrl: string,
): Jf2Entry[] {
  if (looksLikeJson(contentType, body)) {
    return parseJsonFeed(body, baseUrl);
  }
  const root = parseXml(body);
  if (root === null) return [];
  if (root.name === "feed") return parseAtom(root, baseUrl);
  if (root.name === "rss" || root.name === "rdf:rdf")
    return parseRss(root, baseUrl);
  // Some JSON feeds are served with a generic content type and no version tag.
  if (body.trimStart().startsWith("{")) return parseJsonFeed(body, baseUrl);
  return [];
}
