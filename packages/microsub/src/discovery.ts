/**
 * `@dwk/microsub` — feed discovery and fetching.
 *
 * `follow` and `preview` take a URL the user typed; the server must work out
 * what to actually poll. {@link discoverFeed} fetches that URL (through the
 * SSRF-safe wrapper), and:
 *
 * - if it is already a syndication feed (Atom / RSS / JSON Feed), parses it;
 * - if it is HTML, looks for a `<link rel="alternate">` feed and follows the
 *   first one; failing that, parses the page's own `h-feed` microformats.
 *
 * {@link fetchFeed} re-fetches an already-resolved feed URL on each poll,
 * sending the cached `ETag` / `Last-Modified` so an unchanged feed returns `304`
 * and is skipped. Every outbound request goes through {@link safeFetch}, and the
 * body is read with a hard size cap.
 *
 * @packageDocumentation
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";

import { parseHFeed } from "./hfeed.js";
import { parseFeed, type Jf2Entry } from "./jf2.js";
import { MicrosubLogEvent } from "./log.js";
import {
  readBodyCapped as readTextCapped,
  safeFetch,
  type FetchLike,
} from "@dwk/safe-fetch";

/** Shared options for the discovery/fetch helpers. */
export interface DiscoveryOptions {
  readonly fetch?: FetchLike;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  /**
   * Local-dev opt-in passed through to `@dwk/safe-fetch`'s `allowedHosts`:
   * exact `host[:port]` entries exempted from the SSRF private/loopback host
   * block (e.g. `["localhost:4321"]` under `wrangler dev --local`). Never
   * enable in a production composition.
   */
  readonly fetchAllowedHosts?: readonly string[];
}

/** A resolved feed: the URL to poll and the entries parsed from its first fetch. */
export interface DiscoveredFeed {
  /** The URL the poller should re-fetch (a feed, or an HTML `h-feed` page). */
  readonly feedUrl: string;
  /** The entries parsed from the discovery fetch. */
  readonly entries: readonly Jf2Entry[];
}

/** A completed feed fetch. */
export interface FetchedFeed {
  /** The parsed entries (empty when not modified or unparseable). */
  readonly entries: readonly Jf2Entry[];
  /** `true` when the server answered `304 Not Modified`. */
  readonly notModified: boolean;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

/**
 * Cap on a fetched feed/page body (4 MB). Kept local rather than relying on
 * `@dwk/safe-fetch`'s smaller 2 MB default, since this package has always
 * accepted up to 4 MB feeds and that behavior must not silently regress.
 */
const MAX_FEED_BYTES = 4 * 1024 * 1024;

const FEED_ACCEPT =
  "application/atom+xml, application/rss+xml, application/feed+json, " +
  "application/json, text/xml, application/xml, text/html;q=0.9, */*;q=0.8";

/** Feed media types we recognise on a `Content-Type` or a `<link type>`. */
function isFeedType(contentType: string): boolean {
  const essence = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    essence === "application/atom+xml" ||
    essence === "application/rss+xml" ||
    essence === "application/feed+json" ||
    essence === "application/json" ||
    essence === "text/xml" ||
    essence === "application/xml" ||
    essence === "application/rdf+xml"
  );
}

function isHtmlType(contentType: string): boolean {
  const essence = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return essence === "text/html" || essence === "application/xhtml+xml";
}

/** A `<link>` discovered in an HTML head: its rel, type, and resolved href. */
interface FeedLink {
  readonly rels: string[];
  readonly type: string;
  readonly href: string;
}

/** Collect `<link>` elements (rel/type/href) from an HTML document. */
async function findFeedLinks(
  html: string,
  baseUrl: string,
): Promise<FeedLink[]> {
  const links: FeedLink[] = [];
  const rewriter = new HTMLRewriter().on("link", {
    element(el) {
      const href = el.getAttribute("href");
      if (href === null || href === "") return;
      const rels = (el.getAttribute("rel") ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      let resolved: string;
      try {
        resolved = new URL(href, baseUrl).toString();
      } catch {
        return;
      }
      links.push({ rels, type, href: resolved });
    },
  });
  await rewriter.transform(new Response(html)).text();
  return links;
}

/** The first alternate feed `<link>` in document order, if any. */
function pickFeedLink(links: readonly FeedLink[]): FeedLink | null {
  for (const link of links) {
    if (!link.rels.includes("alternate") && link.rels.length > 0) continue;
    if (
      link.type === "application/atom+xml" ||
      link.type === "application/rss+xml" ||
      link.type === "application/feed+json" ||
      link.type === "application/json"
    ) {
      return link;
    }
  }
  return null;
}

/** Parse a fetched body into entries, choosing the parser by content type. */
async function parseBody(
  body: string,
  contentType: string,
  url: string,
): Promise<Jf2Entry[]> {
  if (isHtmlType(contentType)) {
    return parseHFeed(body, url);
  }
  return parseFeed(body, contentType, url);
}

function resolveDeps(options?: DiscoveryOptions): {
  doFetch: FetchLike;
  logger: Logger;
  metrics: Metrics;
} {
  return {
    doFetch: options?.fetch ?? ((input, init) => fetch(input, init)),
    logger: options?.logger ?? noopLogger,
    metrics: options?.metrics ?? noopMetrics,
  };
}

/**
 * Discover the feed at `target`. Returns the URL to poll plus the entries from
 * this first fetch, or `null` when the target is unreachable, blocked, or has no
 * feed and no `h-entry` content.
 */
export async function discoverFeed(
  target: string,
  options?: DiscoveryOptions,
): Promise<DiscoveredFeed | null> {
  const { doFetch, logger, metrics } = resolveDeps(options);

  let response: Response;
  let finalUrl: string;
  try {
    const result = await safeFetch(
      doFetch,
      target,
      { method: "GET", headers: { accept: FEED_ACCEPT } },
      {
        logger,
        metrics,
        logEvent: MicrosubLogEvent.SsrfBlocked,
        allowedHosts: options?.fetchAllowedHosts,
      },
    );
    response = result.response;
    finalUrl = result.url;
  } catch {
    return null;
  }

  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") ?? "";
  const body = await readTextCapped(response, MAX_FEED_BYTES);
  if (body === null) return null;

  // A syndication feed: parse it directly.
  if (
    isFeedType(contentType) ||
    (!isHtmlType(contentType) && looksLikeFeedBody(body))
  ) {
    return {
      feedUrl: finalUrl,
      entries: parseFeed(body, contentType, finalUrl),
    };
  }

  // HTML: prefer a declared alternate feed, else fall back to h-feed.
  if (isHtmlType(contentType) || body.trimStart().startsWith("<")) {
    const links = await findFeedLinks(body, finalUrl);
    const feedLink = pickFeedLink(links);
    if (feedLink !== null) {
      const fetched = await fetchFeed(feedLink.href, options);
      if (fetched !== null) {
        return { feedUrl: feedLink.href, entries: fetched.entries };
      }
    }
    const entries = await parseHFeed(body, finalUrl);
    if (entries.length > 0) {
      return { feedUrl: finalUrl, entries };
    }
  }

  return null;
}

/** Cheap sniff for a feed root when the content type is unhelpful. */
function looksLikeFeedBody(body: string): boolean {
  const head = body.trimStart().slice(0, 512).toLowerCase();
  return (
    head.includes("<rss") ||
    head.includes("<feed") ||
    head.includes("<rdf:rdf") ||
    (head.startsWith("{") && head.includes("jsonfeed.org"))
  );
}

/**
 * Fetch and parse an already-resolved feed URL, sending conditional-request
 * validators when supplied. Returns `notModified` on a `304`, the parsed
 * entries otherwise, or `null` when the fetch fails or is blocked.
 */
export async function fetchFeed(
  feedUrl: string,
  options?: DiscoveryOptions,
  cache?: { etag: string | null; lastModified: string | null },
): Promise<FetchedFeed | null> {
  const { doFetch, logger, metrics } = resolveDeps(options);

  const headers: Record<string, string> = { accept: FEED_ACCEPT };
  if (cache?.etag) headers["if-none-match"] = cache.etag;
  if (cache?.lastModified) headers["if-modified-since"] = cache.lastModified;

  let response: Response;
  let finalUrl: string;
  try {
    const result = await safeFetch(
      doFetch,
      feedUrl,
      { method: "GET", headers },
      {
        logger,
        metrics,
        logEvent: MicrosubLogEvent.SsrfBlocked,
        allowedHosts: options?.fetchAllowedHosts,
      },
    );
    response = result.response;
    finalUrl = result.url;
  } catch {
    return null;
  }

  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");

  if (response.status === 304) {
    await response.body?.cancel().catch(() => undefined);
    return { entries: [], notModified: true, etag, lastModified };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = await readTextCapped(response, MAX_FEED_BYTES);
  if (body === null) return null;
  const entries = await parseBody(body, contentType, finalUrl);
  return { entries, notModified: false, etag, lastModified };
}
