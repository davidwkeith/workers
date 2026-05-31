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

import { getAttr, matchTags, resolveDocumentBase, resolveUrl } from "./html";
import { readBodyCapped, type FetchLike } from "./fetch";

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
  // Respect a <base href> if present, per standard HTML link resolution.
  const documentBase = resolveDocumentBase(html, baseUrl);
  const collect = (tags: readonly string[], attr: "href" | "src") => {
    for (const tag of matchTags(html, tags)) {
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

function isHtml(contentType: string): boolean {
  return /text\/html|application\/xhtml\+xml/i.test(contentType);
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
  if (isHtml(contentType)) {
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
 * Follows redirects and resolves relative links against the final URL. A failed
 * or non-2xx fetch yields `{ links: false }` — a removed/unreachable source no
 * longer endorses the mention.
 */
export async function verifySource(
  source: string,
  target: string,
  options?: VerifyOptions,
): Promise<VerifyResult> {
  const doFetch: FetchLike =
    options?.fetch ?? ((input, init) => fetch(input, init));

  let response: Response;
  try {
    response = await doFetch(source, {
      method: "GET",
      headers: { accept: "text/html, */*" },
      redirect: "follow",
    });
  } catch {
    return { links: false, status: 0 };
  }

  if (!response.ok) {
    return { links: false, status: response.status };
  }

  const base = response.url !== "" ? response.url : source;
  const contentType = response.headers.get("content-type") ?? "";
  const body = await readBodyCapped(response);
  if (body === null) {
    // Unreadable or oversized body: treat as no longer endorsing the mention.
    return { links: false, status: response.status };
  }

  return {
    links: sourceLinksTo(body, target, base, contentType),
    status: response.status,
  };
}
