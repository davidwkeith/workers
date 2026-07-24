/**
 * `@dwk/mf2` — capture-time content sanitizer.
 *
 * `e-content` extracted from a fetched source is untrusted third-party HTML —
 * this runs it through an allowlist sanitizer before it is ever stored, so
 * only pre-sanitized markup reaches D1 or a consuming app's git repo. Built
 * entirely on the runtime's `HTMLRewriter`, matching this package's
 * zero-script-cost approach elsewhere: no external sanitizer dependency.
 *
 * Allowed: `p br em strong b i code pre blockquote ul ol li del s a`. Every
 * attribute is stripped except `a`'s `href` (resolved against `baseUrl`,
 * `http`/`https` only — anything else, including an unresolvable or relative
 * href with no valid base, causes the `<a>` to be unwrapped instead of kept).
 * Every surviving `<a>` gets `rel="ugc nofollow"` forced on, closing the
 * SEO/spam-link vector inherent in surfacing someone else's HTML. `script`
 * and `style` have their entire content dropped, not just unwrapped. Every
 * other element (images, headings, tables, divs/spans used only for layout,
 * …) is unwrapped: the tag itself is dropped but its text/allowed descendants
 * are kept — see `spec/packages/mf2.md` and the tracked follow-up,
 * https://github.com/davidwkeith/workers/issues/413, for what this leaves out
 * and why.
 *
 * @packageDocumentation
 */

import { decodeHtmlEntities } from "./entities.js";
import { escapeHtmlAttr, escapeHtmlText } from "./escape.js";
import { resolveAbsolute } from "./url.js";
import { VOID_ELEMENTS } from "./void-elements.js";

/** Tags kept as-is (minus attributes, except `a`'s `href`). */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
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

/** Tags whose entire subtree (including text) is discarded, not unwrapped. */
const DROP_CONTENT_TAGS: ReadonlySet<string> = new Set(["script", "style"]);

/** A safe `http`/`https` absolute URL for `href`, resolved against `baseUrl`; `null` if unsafe/unresolvable. */
function safeHref(href: string, baseUrl: string): string | null {
  const resolved = resolveAbsolute(href, baseUrl);
  if (resolved === null) return null;
  try {
    const scheme = new URL(resolved).protocol;
    return scheme === "http:" || scheme === "https:" ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Sanitize `html` (untrusted third-party markup) down to the allowlist
 * described above. `baseUrl` resolves relative `href`s on surviving `<a>`
 * elements — pass the fetched source's own URL.
 */
export async function sanitizeContentHtml(
  html: string,
  baseUrl: string,
): Promise<string> {
  if (html === "") return "";

  const out: string[] = [];
  let dropDepth = 0;

  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      const tag = el.tagName;

      if (dropDepth > 0 || DROP_CONTENT_TAGS.has(tag)) {
        if (DROP_CONTENT_TAGS.has(tag) && !VOID_ELEMENTS.has(tag)) {
          dropDepth++;
          el.onEndTag(() => {
            dropDepth--;
          });
        }
        return;
      }

      if (!ALLOWED_TAGS.has(tag)) {
        // Unwrap: emit nothing for this element, but its children/text still
        // stream through the walk normally.
        return;
      }

      if (tag === "a") {
        const href = el.getAttribute("href");
        const safe =
          href === null ? null : safeHref(decodeHtmlEntities(href), baseUrl);
        if (safe === null) {
          // No safe destination: unwrap rather than keep a dead/unsafe link.
          return;
        }
        out.push(`<a href="${escapeHtmlAttr(safe)}" rel="ugc nofollow">`);
        if (!VOID_ELEMENTS.has(tag)) {
          el.onEndTag(() => {
            out.push("</a>");
          });
        }
        return;
      }

      out.push(`<${tag}>`);
      if (!VOID_ELEMENTS.has(tag)) {
        el.onEndTag(() => {
          out.push(`</${tag}>`);
        });
      }
    },
    text(chunk) {
      if (dropDepth > 0) return;
      if (chunk.text === "") return;
      out.push(escapeHtmlText(decodeHtmlEntities(chunk.text)));
    },
  });

  // `HTMLRewriter`'s selector-based `text()` handler only fires for text nodes
  // nested inside a matching element — `html` is a bare fragment (typically
  // starting/ending with plain text, no wrapping element of its own), so
  // top-level text with no element ancestor at all would otherwise never
  // reach `text()`. A synthetic wrapper (an unallowed tag, so it's unwrapped
  // like any other disallowed element — never emitted) gives every text node
  // a matching ancestor.
  await rewriter.transform(new Response(`<div>${html}</div>`)).text();
  return out.join("");
}
