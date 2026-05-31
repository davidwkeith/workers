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

function splitLinks(value: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "<") {
      depth++;
    } else if (char === ">") {
      depth--;
    }
    if (char === "," && depth === 0) {
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

function extractRel(paramString: string): string | null {
  const relMatch = /rel\s*=\s*("([^"]*)"|'([^']*)'|[^;\s]+)/i.exec(paramString);
  if (relMatch === null) {
    return null;
  }
  return relMatch[2] ?? relMatch[3] ?? relMatch[1] ?? null;
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
 * Return every opening tag in `html` whose name is one of `tagNames`
 * (case-insensitive), e.g. `["a", "link"]`.
 */
export function matchTags(html: string, tagNames: readonly string[]): string[] {
  const pattern = new RegExp(`<(?:${tagNames.join("|")})\\b[^>]*>`, "gi");
  return html.match(pattern) ?? [];
}

/** Read a single attribute value off an opening tag, or `null` when absent. */
export function getAttr(tag: string, name: string): string | null {
  const pattern = new RegExp(
    `${name}\\s*=\\s*("([^"]*)"|'([^']*)'|[^\\s>]+)`,
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
