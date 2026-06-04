/**
 * `@dwk/webmention` — small HTML / `Link`-header parsing helpers.
 *
 * Pure, dependency-free string scanning shared by endpoint discovery (sender)
 * and source verification (receiver). We deliberately avoid a full HTML or
 * microformats parser: the runtime budget rules out shipping a heavy parser
 * into the Worker bundle, and Webmention only needs to find links by `rel` and
 * enumerate `href`/`src` targets. No I/O lives here, so it unit-tests without a
 * network. See `spec/non-functional-requirements.md`.
 *
 * @packageDocumentation
 */

/** A parsed `Link` header entry: its target URI and `rel` tokens. */
export interface LinkHeaderEntry {
  readonly uri: string;
  readonly rels: readonly string[];
}

/**
 * Parse an HTTP `Link` header into entries. Handles multiple comma-separated
 * links and semicolon-separated parameters, e.g.
 * `<https://a.example/webmention>; rel="webmention"`.
 *
 * Entries with no `rel` parameter are dropped; an empty URI (`<>`) is kept so
 * the caller can resolve it against the document URL (a Webmention endpoint
 * advertised at the page itself).
 */
export function parseLinkHeader(value: string | null): LinkHeaderEntry[] {
  if (value === null || value.trim() === "") {
    return [];
  }
  const entries: LinkHeaderEntry[] = [];
  for (const part of splitLinks(value)) {
    const match = /^\s*<([^>]*)>\s*(.*)$/.exec(part);
    if (match === null) {
      continue;
    }
    const uri = match[1] ?? "";
    const rels = splitTokens(extractRel(match[2] ?? ""));
    if (rels.length > 0) {
      entries.push({ uri, rels });
    }
  }
  return entries;
}

/**
 * Split a `Link` header on top-level commas, respecting both the angle-bracket
 * URI reference and double-quoted parameter values — so a comma inside
 * `title="A, B"` or inside `<…>` does not split the entry.
 */
function splitLinks(value: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i] as string;
    if (char === '"' && value[i - 1] !== "\\") {
      inQuotes = !inQuotes;
    } else if (!inQuotes && char === "<") {
      depth++;
    } else if (!inQuotes && char === ">") {
      depth--;
    }
    if (char === "," && depth === 0 && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") {
    result.push(current);
  }
  return result;
}

/**
 * Split a `Link` entry's parameter string on top-level semicolons, respecting
 * double-quoted values so a `;` inside a quoted value does not split a param.
 */
function splitParams(paramString: string): string[] {
  const result: string[] = [];
  let inQuotes = false;
  let current = "";
  for (let i = 0; i < paramString.length; i++) {
    const char = paramString[i] as string;
    if (char === '"' && paramString[i - 1] !== "\\") {
      inQuotes = !inQuotes;
    }
    if (char === ";" && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") {
    result.push(current);
  }
  return result;
}

/**
 * Extract the `rel` parameter from a `Link` entry's parameter string. Matches
 * the `rel` parameter exactly (per-parameter), so a `rel=` substring inside
 * another parameter's quoted value (e.g. `title="my rel=x"`) is not mistaken
 * for it.
 */
function extractRel(paramString: string): string | null {
  for (const param of splitParams(paramString)) {
    const match = /^\s*rel\s*=\s*("([^"]*)"|'([^']*)'|[^;\s]+)\s*$/i.exec(
      param,
    );
    if (match !== null) {
      return match[2] ?? match[3] ?? match[1] ?? null;
    }
  }
  return null;
}

/**
 * Whether a `Content-Type` value names an HTML document (`text/html` or
 * `application/xhtml+xml`). Compares the media type's essence — the part before
 * any `;` parameters — case-insensitively, so `text/html; charset=utf-8`
 * matches but an unrelated type carrying `text/html` inside a parameter does
 * not.
 */
export function isHtmlContentType(contentType: string): boolean {
  const essence = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return essence === "text/html" || essence === "application/xhtml+xml";
}

/** Split a whitespace-separated token list (e.g. a `rel` value) into tokens. */
export function splitTokens(value: string | null): string[] {
  if (value === null) {
    return [];
  }
  return value
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
}

/**
 * Strip HTML comments (`<!-- … -->`) from markup before tag scanning, so a
 * `rel="webmention"` element hidden inside a comment is not mistaken for a real
 * endpoint (webmention.rocks discovery test 13).
 */
export function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Return every opening tag in `html` whose name is one of `tagNames`
 * (case-insensitive), e.g. `["a", "link"]`.
 */
export function matchTags(html: string, tagNames: readonly string[]): string[] {
  const pattern = new RegExp(`<(?:${tagNames.join("|")})\\b[^>]*>`, "gi");
  return html.match(pattern) ?? [];
}

/**
 * Read a single attribute value off an opening tag, or `null` when absent.
 *
 * The attribute name must be standalone — preceded by whitespace, `<`, or the
 * start of the string — so a query for `href` does not match `data-href`.
 */
export function getAttr(tag: string, name: string): string | null {
  const pattern = new RegExp(
    `(?:^|[\\s<])${name}\\s*=\\s*("([^"]*)"|'([^']*)'|[^\\s>]+)`,
    "i",
  );
  const match = pattern.exec(tag);
  if (match === null) {
    return null;
  }
  return match[2] ?? match[3] ?? match[1] ?? "";
}

/** Resolve `uri` against `base`, returning a normalized absolute URL or `null`. */
export function resolveUrl(uri: string, base: string): string | null {
  try {
    return new URL(uri, base).toString();
  } catch {
    return null;
  }
}

/**
 * Resolve the effective base URL for a document: the `href` of the first
 * `<base>` tag (resolved against `documentUrl`), or `documentUrl` itself when
 * there is no usable `<base>`. Standard HTML resolution requires relative links
 * to be resolved against this base.
 */
export function resolveDocumentBase(html: string, documentUrl: string): string {
  const baseTags = matchTags(html, ["base"]);
  const first = baseTags[0];
  if (first === undefined) {
    return documentUrl;
  }
  const href = getAttr(first, "href");
  if (href === null || href === "") {
    return documentUrl;
  }
  return resolveUrl(href, documentUrl) ?? documentUrl;
}
