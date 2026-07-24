/**
 * `@dwk/mf2` — HTML void elements.
 *
 * Void elements have no end tag, so `HTMLRewriter#onEndTag` throws on them,
 * and they carry no text/element content of their own. Shared by the
 * extractor ({@link ./hfeed}, deciding whether a property value comes from an
 * attribute vs. text/children) and the sanitizer ({@link ./sanitize}, deciding
 * whether to emit a closing tag).
 *
 * @packageDocumentation
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
