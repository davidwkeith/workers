/**
 * `@dwk/mf2` — HTML void elements, shared by the extractor and the sanitizer.
 *
 * Void elements have no end tag, so `HTMLRewriter#onEndTag` throws on them.
 * They also carry no text content — a `u-photo` / `dt-published` on one always
 * takes its value from an attribute — so handlers commit immediately and never
 * register an end-tag handler for them.
 */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
