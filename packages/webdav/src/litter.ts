/**
 * OS "litter" detection — spec §3.
 *
 * File managers scatter sidecar files (`.DS_Store`, AppleDouble `._*`,
 * `Thumbs.db`, `desktop.ini`). By default the façade accepts these as ordinary
 * blob resources — silently dropping a `PUT` that returns `201` confuses
 * clients. An **optional, off-by-default** denylist MAY refuse or hide them;
 * this module supplies the matcher that backs that option.
 */

/** Default patterns matched against a resource's basename. */
export const DEFAULT_OS_LITTER: readonly RegExp[] = [
  /^\.DS_Store$/,
  /^\._/, // AppleDouble resource forks
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i,
  /^\.Spotlight-V100$/,
  /^\.Trashes$/,
  /^\.fseventsd$/,
  /^\.TemporaryItems$/,
];

/**
 * Whether a path's basename matches a known OS-litter pattern.
 *
 * @param pathOrName A resource path or bare name; only the final segment is
 *   tested.
 * @param patterns Override the default pattern set.
 */
export function isOsLitter(
  pathOrName: string,
  patterns: readonly RegExp[] = DEFAULT_OS_LITTER,
): boolean {
  const base = pathOrName.slice(pathOrName.lastIndexOf("/") + 1);
  return patterns.some((pattern) => pattern.test(base));
}
