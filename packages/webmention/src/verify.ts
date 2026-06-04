/**
 * `@dwk/webmention` — asynchronous source verification (receiver side).
 *
 * After the receiver has returned `202 Accepted`, a queued worker fetches the
 * `source` and confirms it actually links to `target` (Webmention §3.2.1).
 * Verification is link-level: the source document must contain a link
 * (`href`/`src`) that resolves to the target. Full Microformats2 extraction is
 * intentionally out of scope here — it would pull a parser into the Worker
 * bundle the runtime budget rules out. See `spec/packages/webmention.md`.
 *
 * @packageDocumentation
 */

import {
  hostFromUrl,
  noopLogger,
  noopMetrics,
  type Logger,
  type Metrics,
} from "@dwk/log";
import {
  getAttr,
  isHtmlContentType,
  matchTags,
  resolveDocumentBase,
  resolveUrl,
  stripComments,
} from "./html";
import { readBodyCapped, type FetchLike } from "./fetch";
import { WebmentionLogEvent } from "./log";
import { safeFetch } from "./safe-fetch";

/** Elements whose `href` may constitute a link to the target. */
const HREF_TAGS = ["a", "link", "area"] as const;
/** Elements whose `src` may constitute a link to the target. */
const SRC_TAGS = ["img", "video", "audio", "source", "track"] as const;

/**
 * Extract every absolute link URL (`href` and `src`) from an HTML document,
 * resolved against `baseUrl`.
 */
export function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  // Strip comments so a commented-out link doesn't count as a real one, then
  // respect a <base href> if present, per standard HTML link resolution.
  const markup = stripComments(html);
  const documentBase = resolveDocumentBase(markup, baseUrl);
  const collect = (tags: readonly string[], attr: "href" | "src") => {
    for (const tag of matchTags(markup, tags)) {
      const value = getAttr(tag, attr);
      if (value === null || value === "") {
        continue;
      }
      const resolved = resolveUrl(value, documentBase);
      if (resolved !== null) {
        links.push(resolved);
      }
    }
  };
  collect(HREF_TAGS, "href");
  collect(SRC_TAGS, "src");
  return links;
}

/**
 * Decide whether `body` (a fetched source document) links to `target`.
 *
 * HTML bodies are scanned for an `href`/`src` resolving to the target; other
 * content types fall back to a substring match on the target URL.
 */
export function sourceLinksTo(
  body: string,
  target: string,
  baseUrl: string,
  contentType: string,
): boolean {
  const normalizedTarget = resolveUrl(target, target);
  if (normalizedTarget === null) {
    return false;
  }
  if (isHtmlContentType(contentType)) {
    return extractLinks(body, baseUrl).some(
      (link) => link === normalizedTarget,
    );
  }
  return body.includes(target);
}

/** Options for {@link verifySource}. */
export interface VerifyOptions {
  /** `fetch` implementation to use; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Logger for verification outcomes/failures; defaults to a no-op. */
  readonly logger?: Logger;
  /** Metrics sink for verification-outcome counters; defaults to a no-op. */
  readonly metrics?: Metrics;
}

/**
 * Record a verification outcome on both seams (sanitized hosts only) and return
 * the result. The counter mirrors the log so "verification success rate" is
 * chartable from the `links`/`status` fields.
 */
function recordVerifyOutcome(
  logger: Logger,
  metrics: Metrics,
  source: string,
  target: string,
  result: VerifyResult,
): VerifyResult {
  const fields = {
    sourceHost: hostFromUrl(source),
    targetHost: hostFromUrl(target),
    links: result.links,
    status: result.status,
  };
  logger.info(WebmentionLogEvent.VerifyCompleted, fields);
  metrics.count(WebmentionLogEvent.VerifyCompleted, fields);
  return result;
}

/** Outcome of fetching and checking a source document. */
export interface VerifyResult {
  /** Whether the source links to the target. */
  readonly links: boolean;
  /** The source's HTTP status (`0` when the fetch threw). */
  readonly status: number;
}

/**
 * Fetch `source` and verify that it links to `target`.
 *
 * Fetches through the SSRF-safe wrapper ({@link safeFetch}): the source host —
 * and every redirect hop — is validated against private/loopback/link-local
 * ranges, redirects are capped, and the request is bounded by a timeout.
 * Relative links resolve against the final URL. A failed, blocked, or non-2xx
 * fetch yields `{ links: false }` — a removed/unreachable source no longer
 * endorses the mention.
 */
export async function verifySource(
  source: string,
  target: string,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  const doFetch: FetchLike =
    options?.fetch ?? ((input, init) => fetch(input, init));
  const logger = options?.logger ?? noopLogger;
  const metrics = options?.metrics ?? noopMetrics;

  let response: Response;
  let base: string;
  try {
    const result = await safeFetch(
      doFetch,
      source,
      { method: "GET", headers: { accept: "text/html, */*" } },
      { logger, metrics },
    );
    response = result.response;
    base = result.url;
  } catch (err) {
    // A blocked attempt is already logged as `ssrf.blocked` inside safeFetch;
    // record the verification-level failure too so the outcome isn't silent.
    logger.debug(WebmentionLogEvent.VerifyFetchFailed, {
      sourceHost: hostFromUrl(source),
      error: err instanceof Error ? err.name : "unknown",
    });
    return { links: false, status: 0 };
  }

  if (!response.ok) {
    return recordVerifyOutcome(logger, metrics, source, target, {
      links: false,
      status: response.status,
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = await readBodyCapped(response);
  if (body === null) {
    // Unreadable or oversized body: treat as no longer endorsing the mention.
    return recordVerifyOutcome(logger, metrics, source, target, {
      links: false,
      status: response.status,
    });
  }

  return recordVerifyOutcome(logger, metrics, source, target, {
    links: sourceLinksTo(body, target, base, contentType),
    status: response.status,
  });
}
