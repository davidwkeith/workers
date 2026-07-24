/**
 * `@dwk/mf2` — allowlist HTML sanitizer.
 *
 * Captured microformats content is untrusted UGC: before a consumer persists
 * an `e-content` capture (e.g. `@dwk/webmention` storing a reply body), it is
 * reduced to a small formatting allowlist using the runtime's streaming
 * `HTMLRewriter` — no bundled sanitizer dependency, the same
 * zero-script-size-cost philosophy as the extractor (see
 * `spec/non-functional-requirements.md`). Tags outside the allowlist are
 * unwrapped to their text; `script`/`style`-like subtrees are dropped
 * entirely; every attribute is stripped except a validated, absolute
 * `http(s)` `a[href]`; and every surviving link is forced to
 * `rel="ugc nofollow"` so received spam links cannot buy SEO. Output can be
 * truncated on text length, closing any still-open tags.
 *
 * @packageDocumentation
 */

import { decodeEntities } from "./entities.js";
import { VOID_ELEMENTS } from "./void-elements.js";

/** The formatting tags {@link sanitizeHtml} lets through. */
export const SANITIZE_ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "p",
  "br",
  "em",
  "strong",
  "b",
  "i",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "del",
  "s",
  "a",
]);

/**
 * Elements whose entire subtree — text included — is dropped rather than
 * unwrapped: their contents are code, styling, or fallback markup, never prose.
 */
const DROPPED_SUBTREES: ReadonlySet<string> = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "head",
  "title",
  "textarea",
  "select",
]);

/** The `rel` value forced onto every link surviving {@link sanitizeHtml}. */
export const SANITIZE_LINK_REL = "ugc nofollow";

/** Options for {@link sanitizeHtml}. */
export interface SanitizeOptions {
  /**
   * Base URL to resolve link `href`s against. A link that does not resolve to
   * an absolute `http:`/`https:` URL (relative with no base, `javascript:`,
   * `data:`, …) is unwrapped to its text.
   */
  readonly baseUrl?: string;
  /**
   * Maximum text characters (as written in the source, i.e. before entity
   * decoding) to emit before truncating with an ellipsis and closing any open
   * tags. Unlimited when omitted.
   */
  readonly maxTextLength?: number;
}

/** Re-encode a URL for use inside a double-quoted attribute. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

/**
 * Resolve `href` to an absolute `http(s)` URL, or `null` to strip the link.
 * The raw attribute value is decoded first, so an entity-obfuscated scheme
 * (`java&#115;cript:`) is recognized — and rejected — as `javascript:`.
 */
function resolveHttpUrl(href: string | null, baseUrl?: string): string | null {
  if (href === null || href === "") return null;
  href = decodeEntities(href);
  try {
    const url = baseUrl === undefined ? new URL(href) : new URL(href, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Truncate already-encoded text to `length` characters without leaving a
 * severed entity (`&am`) or a severed surrogate pair (half an emoji) at the
 * cut point.
 */
function truncateEncodedText(text: string, length: number): string {
  let cut = text.slice(0, Math.max(0, length));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  const amp = cut.lastIndexOf("&");
  if (amp !== -1 && !cut.slice(amp).includes(";")) {
    cut = cut.slice(0, amp);
  }
  return cut;
}

/**
 * Sanitize untrusted HTML down to the formatting allowlist. Returns the
 * sanitized fragment — possibly `""` when nothing survives. Async because the
 * scan runs through the runtime's streaming `HTMLRewriter`.
 */
export async function sanitizeHtml(
  html: string,
  options?: SanitizeOptions,
): Promise<string> {
  if (html === "") return "";
  const maxTextLength = options?.maxTextLength ?? Number.POSITIVE_INFINITY;
  const baseUrl = options?.baseUrl;

  let out = "";
  let textLength = 0;
  let truncated = false;
  let droppedDepth = 0;
  // Tags emitted but not yet closed. `onEndTag` never fires for an element the
  // source leaves unclosed, so whatever remains here is closed after the parse
  // — stored output must not leak formatting past the fragment.
  const open: Array<{ readonly tag: string }> = [];

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName;
        if (DROPPED_SUBTREES.has(tag)) {
          if (!VOID_ELEMENTS.has(tag)) {
            droppedDepth++;
            el.onEndTag(() => {
              droppedDepth--;
            });
          }
          return;
        }
        if (droppedDepth > 0 || truncated || !SANITIZE_ALLOWED_TAGS.has(tag)) {
          // Unwrapped: the tag is dropped but its text still flows through.
          return;
        }
        if (tag === "br") {
          out += "<br>";
          return;
        }
        if (tag === "a") {
          const resolved = resolveHttpUrl(el.getAttribute("href"), baseUrl);
          if (resolved === null) return;
          out += `<a href="${escapeAttribute(resolved)}" rel="${SANITIZE_LINK_REL}">`;
        } else {
          out += `<${tag}>`;
        }
        const token = { tag };
        open.push(token);
        el.onEndTag(() => {
          const index = open.lastIndexOf(token);
          if (index !== -1) {
            open.splice(index, 1);
            out += `</${tag}>`;
          }
        });
      },
    })
    // Text is handled at the document level: an `on("*")` text handler only
    // fires for text *inside* a matched element, so it would silently drop
    // top-level text — e.g. a text-only content fragment with no wrapping tag.
    .onDocument({
      text(chunk) {
        if (droppedDepth > 0 || truncated || chunk.text === "") return;
        // Text chunks arrive as written (entities are NOT decoded), so they
        // are emitted verbatim — already valid HTML text.
        const remaining = maxTextLength - textLength;
        if (chunk.text.length <= remaining) {
          out += chunk.text;
          textLength += chunk.text.length;
          return;
        }
        out += truncateEncodedText(chunk.text, remaining) + "…";
        truncated = true;
      },
    });

  await rewriter.transform(new Response(html)).text();
  for (const { tag } of open.reverse()) {
    out += `</${tag}>`;
  }
  return out.trim();
}
