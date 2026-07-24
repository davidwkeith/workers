/**
 * `@dwk/mf2` — URL resolution helpers.
 *
 * @packageDocumentation
 */

/** Resolve `href` against `base`; `null` if either is not a resolvable URL. */
export function resolveAbsolute(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * Resolve `href` against `base`, falling back to the original `href` when it
 * doesn't resolve. For best-effort property values (author url/photo) that
 * are stored as-is rather than rendered as markup — unlike
 * {@link resolveAbsolute}'s strict `null`, which callers that must reject an
 * unresolvable URL (e.g. the sanitizer validating `<a href>`) rely on.
 */
export function resolveAbsoluteOrOriginal(href: string, base: string): string {
  return resolveAbsolute(href, base) ?? href;
}
