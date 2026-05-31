/**
 * `@dwk/webmention` — Webmention endpoint discovery (sender side).
 *
 * Given a target URL, find its declared Webmention endpoint following the W3C
 * discovery algorithm: the HTTP `Link` header (`rel=webmention`) wins, then the
 * first `<link>`/`<a rel="webmention">` in document order, with relative URLs
 * resolved against the (post-redirect) document URL. The legacy
 * `http://webmention.org/` rel value is also accepted. See
 * `spec/packages/webmention.md`.
 *
 * @packageDocumentation
 */

import {
  getAttr,
  matchTags,
  parseLinkHeader,
  resolveDocumentBase,
  resolveUrl,
  splitTokens,
} from "./html";
import { readBodyCapped, type FetchLike } from "./fetch";

const LEGACY_REL_PREFIX = "http://webmention.org";

function isWebmentionRel(rel: string): boolean {
  const lower = rel.toLowerCase();
  return lower === "webmention" || lower.startsWith(LEGACY_REL_PREFIX);
}

/**
 * Find the Webmention endpoint declared by a fetched document.
 *
 * Pure: pass the `Link` header value, the response body, and the document URL
 * (used as the base for relative resolution). Returns the absolute endpoint URL
 * or `null` when none is advertised.
 */
export function findWebmentionEndpoint(
  linkHeader: string | null,
  html: string,
  documentUrl: string,
): string | null {
  // 1. HTTP Link header wins, in header order.
  for (const entry of parseLinkHeader(linkHeader)) {
    if (entry.rels.some(isWebmentionRel)) {
      return resolveUrl(entry.uri, documentUrl);
    }
  }
  // 2. Fall back to the first <link>/<a rel="webmention"> in document order,
  //    resolving relative hrefs against the document's <base href> if present.
  const documentBase = resolveDocumentBase(html, documentUrl);
  for (const tag of matchTags(html, ["link", "a"])) {
    const rels = splitTokens(getAttr(tag, "rel"));
    if (rels.some(isWebmentionRel)) {
      // An empty href advertises the document itself as the endpoint.
      return resolveUrl(getAttr(tag, "href") ?? "", documentBase);
    }
  }
  return null;
}

/** Options for {@link discoverEndpoint}. */
export interface DiscoverOptions {
  /** `fetch` implementation to use; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

/**
 * Fetch `target` and discover its Webmention endpoint.
 *
 * Follows redirects and resolves the endpoint against the final URL. Returns
 * the absolute endpoint URL, or `null` when discovery finds none or the fetch
 * fails.
 */
export async function discoverEndpoint(
  target: string,
  options?: DiscoverOptions,
): Promise<string | null> {
  const doFetch: FetchLike =
    options?.fetch ?? ((input, init) => fetch(input, init));

  let response: Response;
  try {
    response = await doFetch(target, {
      method: "GET",
      headers: { accept: "text/html, */*" },
      redirect: "follow",
    });
  } catch {
    return null;
  }

  const base = response.url !== "" ? response.url : target;

  const fromHeader = findWebmentionEndpoint(
    response.headers.get("link"),
    "",
    base,
  );
  if (fromHeader !== null) {
    return fromHeader;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    return null;
  }

  const html = await readBodyCapped(response);
  if (html === null) {
    return null;
  }
  return findWebmentionEndpoint(null, html, base);
}
