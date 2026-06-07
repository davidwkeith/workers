/**
 * Resource-URI normalization for case-insensitive matching (RFC 7033 §4.1;
 * RFC 3986 §3.1 and §6.2.2.1): a URI's **scheme** and **host** are
 * case-insensitive, so a query for `acct:alice@EXAMPLE.COM` must match a
 * configured `acct:alice@example.com`. The local part of an `acct:`/`mailto:`
 * handle is the user identifier and stays **case-sensitive**.
 *
 * Normalization scopes the *lookup key* only: both the queried resource and the
 * configured map keys are normalized before comparison (see `config.ts`). The
 * echoed `subject` keeps the client's literal spelling — the package spec
 * requires the subject to equal the queried resource URI, and fediverse software
 * compares it case-insensitively.
 */

/**
 * Normalize a resource URI for comparison: lowercase the scheme and host,
 * preserving the case of an `acct:`/`mailto:` local part. For `http(s)` URIs the
 * WHATWG `URL` parser performs the scheme/host lowercasing (and its standard
 * path normalization); a URI that does not parse is returned with only its
 * scheme lowercased, and a string with no scheme is returned unchanged.
 */
export function normalizeResource(resource: string): string {
  const colon = resource.indexOf(":");
  if (colon <= 0) return resource;

  const scheme = resource.slice(0, colon).toLowerCase();
  const rest = resource.slice(colon + 1);

  if (scheme === "acct" || scheme === "mailto") {
    const at = rest.lastIndexOf("@");
    if (at === -1) return `${scheme}:${rest}`;
    const local = rest.slice(0, at);
    const host = rest.slice(at + 1).toLowerCase();
    return `${scheme}:${local}@${host}`;
  }

  if (scheme === "http" || scheme === "https") {
    try {
      return new URL(resource).href;
    } catch {
      return `${scheme}:${rest}`;
    }
  }

  return `${scheme}:${rest}`;
}

/**
 * A valid URI scheme per RFC 3986 §3.1: an ALPHA followed by any number of
 * ALPHA / DIGIT / "+" / "-" / ".".
 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/i;

/**
 * Decide whether a queried `resource` is a syntactically well-formed URI
 * (RFC 7033 §4.2): it MUST carry a scheme (RFC 3986 §3.1), and an `http(s)`
 * resource MUST additionally parse as an absolute URL. A value with no scheme,
 * an ill-formed scheme, or an unparseable `http(s)` authority is *malformed*,
 * and the handler answers `400` (not `404`) before any lookup — §4.2 requires a
 * "bad request" indication when `resource` is absent **or malformed**.
 *
 * Validation is deliberately minimal: a syntactically valid scheme is enough for
 * non-`http(s)` URIs (`acct:`, `mailto:`, `urn:`), since the resolver — not this
 * gate — owns whether such a resource is controlled.
 */
export function isWellFormedResource(resource: string): boolean {
  const colon = resource.indexOf(":");
  if (colon <= 0) return false;

  const scheme = resource.slice(0, colon).toLowerCase();
  if (!SCHEME_PATTERN.test(scheme)) return false;

  if (scheme === "http" || scheme === "https") {
    try {
      new URL(resource);
    } catch {
      return false;
    }
  }

  return true;
}
