/**
 * `@dwk/mf2` — HTML text/attribute escaping.
 *
 * Shared by the extractor ({@link ./hfeed}, re-serializing captured `e-content`
 * markup) and the sanitizer ({@link ./sanitize}, emitting its allowlisted
 * output) so re-serialized text/attribute values can't reintroduce markup.
 *
 * @packageDocumentation
 */

/** Escape text for use as HTML element content. */
export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a value for use inside a double-quoted HTML attribute. */
export function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
