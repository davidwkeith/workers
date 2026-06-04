/**
 * Profile-URL canonicalization and `rel=me` discovery.
 *
 * IndieAuth identifies users by a *profile URL*. The validation and
 * canonicalization rules below are taken from the IndieAuth specification's
 * "User Profile URL" section. The `rel=me` parser supports profile-URL
 * verification (web sign-in): a profile is confirmed when it links back to the
 * authenticating identity. The parser takes already-fetched HTML as plain data
 * (the caller does the network I/O) and scans it with the Workers runtime's
 * streaming `HTMLRewriter`, so it is async and exercised under the Workers test
 * pool rather than bare Node.
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
 *
 * Scanning uses the Workers runtime's streaming `HTMLRewriter` (hence async):
 * elements inside comments are never reported, so a commented-out `<a rel="me">`
 * cannot forge a back-link, and a `data-rel`/`data-href` attribute is never
 * mistaken for `rel`/`href`.
 */
export async function parseRelMeLinks(
  html: string,
  baseUrl: string,
): Promise<string[]> {
  const found = new Set<string>();
  const rewriter = new HTMLRewriter().on("a, link", {
    element(el) {
      const rel = el.getAttribute("rel");
      if (rel === null) return;
      const hasMe = rel
        .split(/\s+/)
        .some((token) => token.toLowerCase() === "me");
      if (!hasMe) return;
      const href = el.getAttribute("href");
      if (href === null) return;
      try {
        found.add(new URL(href, baseUrl).toString());
      } catch {
        // Skip unparseable href values.
      }
    },
  });
  // Drive the parser to completion by consuming the transformed body.
  await rewriter.transform(new Response(html)).text();
  return [...found];
}

/**
 * Whether `candidate` confirms ownership of `profileUrl`: true when any
 * `rel=me` link in `candidate`'s HTML points back at the profile (compared
 * after profile-URL canonicalization).
 */
export async function relMeLinksBack(
  candidateHtml: string,
  candidateUrl: string,
  profileUrl: string,
): Promise<boolean> {
  const target = canonicalizeProfileUrl(profileUrl);
  if (target === null) return false;
  const links = await parseRelMeLinks(candidateHtml, candidateUrl);
  return links.some((link) => canonicalizeProfileUrl(link) === target);
}
