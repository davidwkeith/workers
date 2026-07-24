/**
 * `@dwk/mf2` — minimal HTML entity decoding.
 *
 * This runtime's `HTMLRewriter` hands back **raw, undecoded** text chunks and
 * attribute values (verified empirically: `&amp;` in an `href` round-trips as
 * the literal five characters). Left raw, a `u-in-reply-to` pointing at
 * `…?a=1&amp;b=2` would never match the normalized target `…?a=1&b=2`, and
 * re-escaping a raw value would double-escape it. So every place a value is
 * *interpreted* (URL matching/resolution, plain-text properties, attribute
 * re-serialization) decodes first; captured/emitted HTML stays encoded as
 * written.
 *
 * Deliberately minimal — the five predefined named entities plus numeric
 * character references — not the full HTML5 named-entity table (which would
 * be a bundled data blob; see `spec/non-functional-requirements.md`). An
 * unrecognized reference is left as written.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decode named (`&amp;`) and numeric (`&#38;` / `&#x26;`) references. */
export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(
    /&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z]+);/g,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        // Reject out-of-range and lone-surrogate code points.
        if (
          !Number.isFinite(code) ||
          code < 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        ) {
          return match;
        }
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}
