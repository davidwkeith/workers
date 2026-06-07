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

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";
import {
  isHtmlContentType,
  parseLinkHeader,
  resolveUrl,
  scanElements,
  splitTokens,
} from "./html";
import { readBodyCapped, type FetchLike } from "./fetch";
import { safeFetch } from "./safe-fetch";

// The legacy rel values predating the standardized `webmention` token. They are
// absolute URLs, so a candidate rel is normalized through `URL` before being
// compared: `http://webmention.org` and `http://webmention.org/` then coincide
// (tolerating the trailing slash developers commonly omit), while a look-alike
// host like `http://webmention.org.evil.example/` parses to a different href and
// is rejected — which a bare `startsWith` prefix test would not catch.
const LEGACY_REL_HREFS = new Set([
  "http://webmention.org/",
  "http://webmention.org/webmention",
]);

function isWebmentionRel(rel: string): boolean {
  if (rel.toLowerCase() === "webmention") {
    return true;
  }
  let href: string;
  try {
    href = new URL(rel).href;
  } catch {
    // Not the standard token and not an absolute URL — not a webmention rel.
    return false;
  }
  return LEGACY_REL_HREFS.has(href);
}

/**
 * Find the Webmention endpoint declared by a fetched document.
 *
 * Pass the `Link` header value, the response body, and the document URL (used
 * as the base for relative resolution). Returns the absolute endpoint URL or
 * `null` when none is advertised. Async because HTML scanning runs through the
 * runtime's `HTMLRewriter`.
 */
export async function findWebmentionEndpoint(
  linkHeader: string | null,
  html: string,
  documentUrl: string,
): Promise<string | null> {
  // 1. HTTP Link header wins, in header order.
  for (const entry of parseLinkHeader(linkHeader)) {
    if (entry.rels.some(isWebmentionRel)) {
      return resolveUrl(entry.uri, documentUrl);
    }
  }
  // 2. Fall back to the first <link>/<a rel="webmention"> in document order,
  //    resolving relative hrefs against the document's <base href> if present.
  //    HTMLRewriter does not report elements inside comments, so a commented-out
  //    endpoint is ignored without a separate stripping pass.
  if (html === "") {
    return null;
  }
  const elements = await scanElements(html, "base, link, a", ["rel", "href"]);
  // The first <base href> anywhere in the document governs relative resolution.
  let documentBase = documentUrl;
  for (const el of elements) {
    if (el.name === "base" && el.attrs.href) {
      documentBase = resolveUrl(el.attrs.href, documentUrl) ?? documentUrl;
      break;
    }
  }
  for (const el of elements) {
    if (el.name === "base") {
      continue;
    }
    const rels = splitTokens(el.attrs.rel ?? null);
    if (!rels.some(isWebmentionRel)) {
      continue;
    }
    const href = el.attrs.href;
    // A tag with no `href` attribute at all is malformed — skip it and keep
    // looking (test 20). An empty `href=""` is valid and advertises the
    // document itself as the endpoint (test 15).
    if (href === null || href === undefined) {
      continue;
    }
    return resolveUrl(href, documentBase);
  }
  return null;
}

/** Options for {@link discoverEndpoint}. */
export interface DiscoverOptions {
  /** `fetch` implementation to use; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Logger passed through to the SSRF-safe fetch; defaults to a no-op. */
  readonly logger?: Logger;
  /** Metrics sink passed through to the SSRF-safe fetch; defaults to a no-op. */
  readonly metrics?: Metrics;
}

/**
 * Fetch `target` and discover its Webmention endpoint.
 *
 * Fetches through the SSRF-safe wrapper ({@link safeFetch}): the target host —
 * and every redirect hop — is validated against private/loopback/link-local
 * ranges, redirects are capped, and the request is bounded by a timeout. The
 * endpoint resolves against the final URL. Returns the absolute endpoint URL,
 * or `null` when discovery finds none or the fetch fails or is blocked.
 */
export async function discoverEndpoint(
  target: string,
  options?: DiscoverOptions,
): Promise<string | null> {
  const doFetch: FetchLike =
    options?.fetch ?? ((input, init) => fetch(input, init));
  const logger = options?.logger ?? noopLogger;
  const metrics = options?.metrics ?? noopMetrics;

  let response: Response;
  let base: string;
  try {
    const result = await safeFetch(
      doFetch,
      target,
      { method: "GET", headers: { accept: "text/html, */*" } },
      { logger, metrics },
    );
    response = result.response;
    base = result.url;
  } catch {
    return null;
  }

  const fromHeader = await findWebmentionEndpoint(
    response.headers.get("link"),
    "",
    base,
  );
  if (fromHeader !== null) {
    return fromHeader;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!isHtmlContentType(contentType)) {
    return null;
  }

  const html = await readBodyCapped(response);
  if (html === null) {
    return null;
  }
  return findWebmentionEndpoint(null, html, base);
}
