/**
 * `@dwk/mf2` — minimal HTML entity decoding.
 *
 * This runtime's `HTMLRewriter` hands text/attribute values back **raw** —
 * entity references are not decoded (verified empirically: `&amp;` in an
 * attribute or text node round-trips as the literal 5 characters, not `&`).
 * Every read site in this package decodes through here first, so a value can
 * be safely re-escaped on the way back out (e.g. `sanitize.ts`'s output, or a
 * resolved `href`) without either double-escaping an entity that was already
 * there, or mis-resolving a URL whose query string uses `&amp;` for `&` (the
 * common, spec-correct way to write an ampersand in an HTML attribute).
 *
 * Covers the five named entities HTML defines an unambiguous meaning for
 * without a trailing `;` risk (`amp`, `lt`, `gt`, `quot`, `apos`) plus decimal
 * and hex numeric character references. Any other named entity (`&nbsp;`,
 * `&mdash;`, …) is left as-is — a cosmetic-only limitation (the entity text
 * displays literally rather than as its glyph), not a security one, in
 * keeping with this package being a pragmatic extractor rather than a full
 * HTML engine.
 *
 * @packageDocumentation
 */

const NAMED: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g;

/** Decode the entity references this package understands; leave the rest as-is. */
export function decodeHtmlEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(ENTITY_RE, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeCodePoint(code, match) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeCodePoint(code, match) : match;
    }
    return NAMED.get(body) ?? match;
  });
}

/** `String.fromCodePoint`, falling back to the original match on an invalid code point. */
function safeCodePoint(code: number, original: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return original;
  }
}
