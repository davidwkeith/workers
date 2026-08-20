/**
 * `@dwk/webmention` — asynchronous source verification (receiver side).
 *
 * After the receiver has returned `202 Accepted`, a queued worker fetches the
 * `source` and confirms it actually links to `target` (Webmention §3.2.1).
 * Verification is link-level: the source document must contain a link
 * (`href`/`src`) that resolves to the target. A verified HTML source is then
 * read once more for its microformats — via the shared, `HTMLRewriter`-based
 * `@dwk/mf2` extractor, not a bundled parser (which the runtime budget rules
 * out) — to enrich the mention with its interaction type, author, content,
 * and publication time ({@link ./enrich}). See `spec/packages/webmention.md`.
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
  isHtmlContentType,
  isJsonContentType,
  resolveUrl,
  scanElements,
} from "./html.js";
import { readBodyCapped, safeFetch, type FetchLike } from "@dwk/safe-fetch";
import {
  extractEnrichment,
  type InteractionType,
  type MentionAuthor,
  type MentionEnrichment,
} from "./enrich.js";
import { WebmentionLogEvent } from "./log.js";
import { extractRsvp, type RsvpValue } from "./rsvp.js";

/** Elements whose `href` may constitute a link to the target. */
const HREF_TAGS = new Set(["a", "link", "area"]);
/** Elements whose `src` may constitute a link to the target. */
const SRC_TAGS = new Set(["img", "video", "audio", "source", "track"]);

const LINK_SELECTOR = "base, a, link, area, img, video, audio, source, track";

/**
 * Extract every absolute link URL (`href` and `src`) from an HTML document,
 * resolved against `baseUrl`. `href` links are listed before `src` links.
 *
 * Async because HTML scanning runs through the runtime's `HTMLRewriter`, which
 * also means links inside comments are ignored without a separate stripping
 * pass.
 */
export async function extractLinks(
  html: string,
  baseUrl: string,
): Promise<string[]> {
  const elements = await scanElements(html, LINK_SELECTOR, ["href", "src"]);
  // The first <base href> anywhere in the document governs relative resolution.
  let documentBase = baseUrl;
  for (const el of elements) {
    if (el.name === "base" && el.attrs.href) {
      documentBase = resolveUrl(el.attrs.href, baseUrl) ?? baseUrl;
      break;
    }
  }
  const links: string[] = [];
  const collect = (tags: ReadonlySet<string>, attr: "href" | "src") => {
    for (const el of elements) {
      if (!tags.has(el.name)) {
        continue;
      }
      const value = el.attrs[attr];
      if (value === null || value === undefined || value === "") {
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
 * Characters that unambiguously continue a URL token: an alphanumeric, or a
 * structural delimiter (path / query / fragment / userinfo). One of these
 * abutting the target means the target is part of a longer URL.
 */
const URL_CORE_CHAR = /[A-Za-z0-9_/\-~%+=&?#@]/;

/**
 * The full RFC 3986 URL character set (unreserved + reserved + `%`). Punctuation
 * such as `.` `,` `;` `)` `]` is valid inside a URL but also routinely trails or
 * wraps one in prose, so on its own it does not prove continuation — only when
 * it is itself followed by a {@link URL_CORE_CHAR} (e.g. the `.` in `…/post.html`).
 */
const URL_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;

/**
 * Whether `body` contains `target` as a standalone URL token — present, with
 * neither neighbour continuing a URL. This rejects the over-matches a bare
 * substring admits (`…/post` inside `…/posting`, `…/target` inside
 * `…/target/extra`, or the target as a suffix of a longer URL) while still
 * accepting a target trailed by sentence punctuation or wrapped in brackets.
 */
function textHasUrlToken(body: string, target: string): boolean {
  for (
    let from = body.indexOf(target);
    from !== -1;
    from = body.indexOf(target, from + 1)
  ) {
    const before = from === 0 ? "" : (body[from - 1] ?? "");
    const after = body[from + target.length] ?? "";
    const afterNext = body[from + target.length + 1] ?? "";
    // A preceding core URL char makes the target a suffix of a longer URL.
    const beforeContinues = URL_CORE_CHAR.test(before);
    // A following core URL char continues the URL; a punctuation URL char only
    // continues it when itself followed by a core char (so `.html` continues,
    // but a sentence-ending `.` or a wrapping `)` is a boundary).
    const afterContinues =
      URL_CORE_CHAR.test(after) ||
      (URL_CHAR.test(after) && URL_CORE_CHAR.test(afterNext));
    if (!beforeContinues && !afterContinues) {
      return true;
    }
  }
  return false;
}

/**
 * Whether any string value within a parsed JSON value equals `target` exactly.
 * Webmention §3.2.2 requires an exact match of the target URL in a non-HTML
 * source, so a JSON body is walked for a string property value identical to the
 * target rather than substring-scanned.
 */
function jsonHasTargetValue(value: unknown, target: string): boolean {
  if (typeof value === "string") {
    return value === target;
  }
  if (Array.isArray(value)) {
    return value.some((item) => jsonHasTargetValue(item, target));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) =>
      jsonHasTargetValue(item, target),
    );
  }
  return false;
}

/**
 * Decide whether `body` (a fetched source document) links to `target`.
 *
 * HTML bodies are scanned for an `href`/`src` resolving to the target. Other
 * content types require an **exact** match of the target URL (Webmention
 * §3.2.2), not a loose substring: a JSON body must carry a string value equal to
 * the target, and any other (e.g. plain text) body must contain the target as a
 * standalone URL token.
 */
export async function sourceLinksTo(
  body: string,
  target: string,
  baseUrl: string,
  contentType: string,
): Promise<boolean> {
  const normalizedTarget = resolveUrl(target, target);
  if (normalizedTarget === null) {
    return false;
  }
  if (isHtmlContentType(contentType)) {
    return (await extractLinks(body, baseUrl)).some(
      (link) => link === normalizedTarget,
    );
  }
  if (isJsonContentType(contentType)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // A body that claims to be JSON but does not parse cannot exact-match.
      return false;
    }
    return (
      jsonHasTargetValue(parsed, target) ||
      (normalizedTarget !== target &&
        jsonHasTargetValue(parsed, normalizedTarget))
    );
  }
  return (
    textHasUrlToken(body, target) ||
    (normalizedTarget !== target && textHasUrlToken(body, normalizedTarget))
  );
}

/** Options for {@link verifySource}. */
export interface VerifyOptions {
  /** `fetch` implementation to use; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Logger for verification outcomes/failures; defaults to a no-op. */
  readonly logger?: Logger;
  /** Metrics sink for verification-outcome counters; defaults to a no-op. */
  readonly metrics?: Metrics;
  /**
   * Local-dev opt-in passed through to `@dwk/safe-fetch`'s `allowedHosts`:
   * exact `host[:port]` entries exempted from the SSRF private/loopback host
   * block (e.g. `["localhost:4321"]` under `wrangler dev --local`). Never
   * enable in a production composition.
   */
  readonly fetchAllowedHosts?: readonly string[];
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
    // The rsvp and interaction-type values are closed, non-sensitive sets, so
    // they are safe to surface for observability (author/content are not).
    ...(result.rsvp !== undefined ? { rsvp: result.rsvp } : {}),
    ...(result.interactionType !== undefined
      ? { interactionType: result.interactionType }
      : {}),
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
  /**
   * The Indie RSVP value when the source is an RSVP to the target (a `p-rsvp`
   * plus a `u-in-reply-to` aimed at the target); omitted otherwise. See
   * {@link extractRsvp}.
   */
  readonly rsvp?: RsvpValue;
  /**
   * How the source interacts with the target, from the mf2 of the one
   * `h-entry` responding to it (see {@link extractEnrichment}); a verified
   * source with no such entry — including a non-HTML source — is a plain
   * `"mention"`. Omitted only when the source does not link at all.
   */
  readonly interactionType?: InteractionType;
  /** The responding entry's author, when it declares one. */
  readonly author?: MentionAuthor;
  /** Sanitized, truncated HTML of the responding entry's content. */
  readonly content?: string;
  /** The responding entry's declared `dt-published` value, verbatim. */
  readonly published?: string;
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
      {
        logger,
        metrics,
        logEvent: WebmentionLogEvent.SsrfBlocked,
        allowedHosts: options?.fetchAllowedHosts,
      },
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

  const links = await sourceLinksTo(body, target, base, contentType);
  const isHtml = isHtmlContentType(contentType);
  // Only an HTML source that genuinely links to the target can be an RSVP; a
  // `u-in-reply-to` is itself a link, so RSVP detection presupposes `links`.
  const rsvp = links && isHtml ? await extractRsvp(body, base, target) : null;
  // Same precondition for enrichment; a verified non-HTML source has no mf2
  // to read, so it is a plain mention.
  const enrichment: MentionEnrichment | null = links
    ? isHtml
      ? await extractEnrichment(body, base, target)
      : { interactionType: "mention" }
    : null;
  return recordVerifyOutcome(logger, metrics, source, target, {
    links,
    status: response.status,
    ...(rsvp !== null ? { rsvp } : {}),
    ...(enrichment ?? {}),
  });
}

/** Outcome of fetching and checking a Vouch URL. */
export interface VouchResult {
  /** Whether the vouch page links anywhere under the target's hostname. */
  readonly verified: boolean;
}

/**
 * Fetch `vouchUrl` and check whether it links anywhere under `target`'s
 * hostname — the Vouch protocol's trust signal (indieweb.org/Vouch): a page
 * already known to (or trusted by) the sender is fetched and confirmed to
 * link back to the target's domain, raising confidence the mention isn't
 * spam.
 *
 * Uses the same SSRF-safe {@link safeFetch} wrapper as {@link verifySource}.
 * Unlike {@link sourceLinksTo}'s exact-URL match, this checks **hostname**
 * equality — any link on the vouch page pointing anywhere under the target's
 * host counts, per the "domain of the target" wording of the spec. Only HTML
 * vouch pages are scanned (this is a hyperlink check, not the multi-format
 * exact-match Webmention verification itself needs). Any fetch failure,
 * non-2xx status, non-HTML response, or oversized/unreadable body yields
 * `{ verified: false }`; this function never throws.
 */
export async function verifyVouch(
  vouchUrl: string,
  target: string,
  options?: VerifyOptions,
): Promise<VouchResult> {
  const doFetch: FetchLike =
    options?.fetch ?? ((input, init) => fetch(input, init));
  const logger = options?.logger ?? noopLogger;
  const metrics = options?.metrics ?? noopMetrics;

  let targetHost: string;
  try {
    targetHost = new URL(target).hostname.toLowerCase();
  } catch {
    return { verified: false };
  }

  let response: Response;
  let base: string;
  try {
    const result = await safeFetch(
      doFetch,
      vouchUrl,
      { method: "GET", headers: { accept: "text/html, */*" } },
      {
        logger,
        metrics,
        logEvent: WebmentionLogEvent.SsrfBlocked,
        allowedHosts: options?.fetchAllowedHosts,
      },
    );
    response = result.response;
    base = result.url;
  } catch {
    return { verified: false };
  }

  if (!response.ok) {
    return { verified: false };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!isHtmlContentType(contentType)) {
    return { verified: false };
  }

  const body = await readBodyCapped(response);
  if (body === null) {
    return { verified: false };
  }

  const links = await extractLinks(body, base);
  const verified = links.some((link) => {
    try {
      return new URL(link).hostname.toLowerCase() === targetHost;
    } catch {
      return false;
    }
  });

  const fields = {
    vouchHost: hostFromUrl(vouchUrl),
    targetHost: hostFromUrl(target),
    verified,
  };
  logger.info(WebmentionLogEvent.VouchVerified, fields);
  metrics.count(WebmentionLogEvent.VouchVerified, fields);
  return { verified };
}
