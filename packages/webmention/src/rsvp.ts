/**
 * `@dwk/webmention` — Indie RSVP recognition.
 *
 * An Indie RSVP is a reply `h-entry` whose microformats2 carries `p-rsvp`
 * (`yes` / `no` / `maybe` / `interested`) and a `u-in-reply-to` pointing at the
 * event URL, delivered as a Webmention. Recognizing one is a deliberately
 * *bounded* mf2 read: rather than pull a full Microformats2 parser into the
 * Worker bundle (ruled out by the runtime budget — see
 * `spec/non-functional-requirements.md`), the two properties an RSVP needs are
 * extracted directly with the runtime's streaming `HTMLRewriter`, the same tool
 * source verification already uses (`html.ts`). So this stays zero script-size
 * cost and is exercised under the Workers test pool.
 *
 * @see https://indieweb.org/rsvp
 * @see spec/packages/webmention.md
 * @packageDocumentation
 */

import { decodeEntities } from "@dwk/mf2";

import { resolveUrl } from "./html.js";

/** The recognized Indie RSVP values (mf2 `p-rsvp`). */
export const RSVP_VALUES = ["yes", "no", "maybe", "interested"] as const;

/** A recognized Indie RSVP value. */
export type RsvpValue = (typeof RSVP_VALUES)[number];

const RSVP_VALUE_SET: ReadonlySet<string> = new Set(RSVP_VALUES);

/**
 * Cap on accumulated `p-rsvp` text. A valid value is a short token
 * (`interested` is the longest at 10 chars), so this bound is generous while
 * guarding {@link extractRsvp} — a public entry taking arbitrary HTML — against
 * an oversized text node ballooning the buffer.
 */
const MAX_RSVP_TEXT = 128;

/** Whether `value` (already trimmed/lowercased) is a recognized {@link RsvpValue}. */
export function isRsvpValue(value: string): value is RsvpValue {
  return RSVP_VALUE_SET.has(value);
}

/** Normalize a candidate rsvp token, returning it only if recognized. */
function normalizeRsvp(raw: string): RsvpValue | null {
  const normalized = raw.trim().toLowerCase();
  return isRsvpValue(normalized) ? normalized : null;
}

/**
 * Extract the Indie RSVP value from a source document replying to `target`.
 *
 * Returns the recognized rsvp value only when the source carries **both** a
 * `p-rsvp` with a recognized value **and** marks up `target` as a
 * `u-in-reply-to` — the two halves of an Indie RSVP. Missing either half (a
 * plain reply, or an rsvp aimed at a different post) yields `null`, so the
 * mention is recorded as an ordinary Webmention rather than an RSVP.
 *
 * The `p-rsvp` value follows the mf2 `p-*` rule: a `value` attribute
 * (`<data class="p-rsvp" value="yes">`, the IndieWeb-recommended markup) is
 * authoritative, otherwise the element's text content is used.
 */
export async function extractRsvp(
  html: string,
  baseUrl: string,
  target: string,
): Promise<RsvpValue | null> {
  const normalizedTarget = resolveUrl(target, target);
  if (normalizedTarget === null) {
    return null;
  }

  let repliesToTarget = false;
  let rsvp: RsvpValue | null = null;
  // Depth counter + buffer so the `text` handler only accrues the text of the
  // `p-rsvp` element currently open, and the `value` attribute (when present)
  // wins over the text fallback resolved at the end tag.
  let depth = 0;
  let text = "";

  const rewriter = new HTMLRewriter()
    .on('[class~="u-in-reply-to"]', {
      element(el) {
        const href = el.getAttribute("href");
        if (href === null || href === "") {
          return;
        }
        // Attribute values arrive raw; decode so `…?a=1&amp;b=2` matches.
        if (resolveUrl(decodeEntities(href), baseUrl) === normalizedTarget) {
          repliesToTarget = true;
        }
      },
    })
    .on('[class~="p-rsvp"]', {
      element(el) {
        const valueAttr = el.getAttribute("value");
        if (rsvp === null && valueAttr !== null) {
          rsvp = normalizeRsvp(valueAttr);
        }
        depth++;
        text = "";
        el.onEndTag(() => {
          depth--;
          if (rsvp === null) {
            rsvp = normalizeRsvp(text);
          }
        });
      },
      text(chunk) {
        if (depth > 0 && text.length < MAX_RSVP_TEXT) {
          text += chunk.text;
        }
      },
    });

  await rewriter.transform(new Response(html)).text();
  return repliesToTarget ? rsvp : null;
}
