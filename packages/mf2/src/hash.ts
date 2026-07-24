/**
 * `@dwk/mf2` — small stable non-cryptographic hash (FNV-1a), base36-rendered.
 *
 * Used to derive a fallback {@link Jf2Entry._id} when a source entry has no
 * usable `url`, and available to consumers (e.g. `@dwk/webmention`, deriving a
 * stable inbox record id from `(source, target)`) that want an identical
 * derivation strategy rather than inventing their own.
 *
 * @packageDocumentation
 */

/** FNV-1a hash of `input`, rendered as an unsigned base36 string. */
export function fnv1aBase36(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
