/**
 * Profile-URL canonicalization and `rel=me` discovery.
 *
 * IndieAuth identifies users by a *profile URL*. The validation and
 * canonicalization rules below are taken from the IndieAuth specification's
 * "User Profile URL" section. The `rel=me` parser supports profile-URL
 * verification (web sign-in): a profile is confirmed when it links back to the
 * authenticating identity. The parser takes HTML as plain data so it unit-tests
 * without any network access — the caller fetches the document.
 *
 * @see https://indieauth.spec.indieweb.org/#user-profile-url
 */

/**
 * Validate and canonicalize an IndieAuth profile URL, or return `null` if it
 * does not satisfy the specification's constraints.
 *
 * A profile URL MUST use `https`/`http`, carry a path (an empty path is
 * canonicalized to `/`), and MUST NOT contain a fragment, credentials, port, or
 * dot path segments, and its host MUST be a domain name (not an IP address).
 */
export function canonicalizeProfileUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;

  // No single-dot or double-dot path segments. The URL parser silently resolves
  // these away, so the raw input must be inspected before canonicalization.
  if (/\/\.\.?(\/|$)/.test(input)) return null;

  // Host must be a domain name, not an IPv4/IPv6 literal.
  if (url.hostname.startsWith("[")) return null; // IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) return null; // IPv4

  // Canonicalize: an empty path becomes "/".
  if (url.pathname === "") url.pathname = "/";

  return url.toString();
}

/**
 * Extract `rel=me` link targets from an HTML document, resolved against
 * `baseUrl`. Scans both `<a>` and `<link>` elements whose space-separated `rel`
 * token list contains `me`. Returns a de-duplicated list in document order.
 */
export function parseRelMeLinks(html: string, baseUrl: string): string[] {
  // Strip HTML comments first so a commented-out `<a rel="me">` is not treated
  // as a live back-link (comment injection).
  const cleanHtml = html.replace(/<!--[\s\S]*?-->/g, "");
  const found = new Set<string>();
  // Match <a ...> and <link ...> start tags; inspect their attributes.
  const tagPattern = /<(a|link)\b([^>]*)>/gi;
  for (const match of cleanHtml.matchAll(tagPattern)) {
    const attrs = match[2] ?? "";
    const rel = attrValue(attrs, "rel");
    if (rel === null) continue;
    const hasMe = rel
      .split(/\s+/)
      .some((token) => token.toLowerCase() === "me");
    if (!hasMe) continue;
    const href = attrValue(attrs, "href");
    if (href === null) continue;
    try {
      found.add(new URL(href, baseUrl).toString());
    } catch {
      // Skip unparseable href values.
    }
  }
  return [...found];
}

/**
 * Read an attribute value (double-quoted, single-quoted, or unquoted) from a
 * raw attribute string. Anchors the name on a preceding start-or-whitespace
 * boundary rather than `\b`, so `data-rel`/`data-href` are not mistaken for
 * `rel`/`href` (a hyphen is a `\b` boundary).
 */
function attrValue(attrs: string, name: string): string | null {
  const pattern = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const m = pattern.exec(attrs);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

/**
 * Whether `candidate` confirms ownership of `profileUrl`: true when any
 * `rel=me` link in `candidate`'s HTML points back at the profile (compared
 * after profile-URL canonicalization).
 */
export function relMeLinksBack(
  candidateHtml: string,
  candidateUrl: string,
  profileUrl: string,
): boolean {
  const target = canonicalizeProfileUrl(profileUrl);
  if (target === null) return false;
  return parseRelMeLinks(candidateHtml, candidateUrl).some(
    (link) => canonicalizeProfileUrl(link) === target,
  );
}
