/**
 * `@dwk/webmention` — HTML / `Link`-header parsing helpers.
 *
 * Shared by endpoint discovery (sender) and source verification (receiver).
 * `Link`-header parsing is plain string scanning; HTML scanning uses the
 * Workers runtime's streaming `HTMLRewriter` rather than regex tag matching, so
 * it handles comments, attribute quoting, and malformed markup correctly
 * without pulling a parser into the bundle (`HTMLRewriter` is built into the
 * runtime — zero script-size cost; see `spec/non-functional-requirements.md`).
 *
 * Because `HTMLRewriter` is a `workerd` global, the HTML scanners are async and
 * exercised under the Workers test pool, not bare Node.
 *
 * @packageDocumentation
 */

import { decodeEntities } from "@dwk/mf2";

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

/**
 * Whether a `Content-Type` value names a JSON document (`application/json` or a
 * `+json`-suffixed type such as `application/activity+json`). Compares the media
 * type's essence — the part before any `;` parameters — case-insensitively.
 */
export function isJsonContentType(contentType: string): boolean {
  const essence = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return essence === "application/json" || essence.endsWith("+json");
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

/** Resolve `uri` against `base`, returning a normalized absolute URL or `null`. */
export function resolveUrl(uri: string, base: string): string | null {
  try {
    return new URL(uri, base).toString();
  } catch {
    return null;
  }
}

/** An element seen by {@link scanElements}: its (lowercased) tag name and the requested attributes. */
export interface ScannedElement {
  /** Lowercased tag name, e.g. `"a"`, `"link"`, `"base"`. */
  readonly name: string;
  /** Requested attribute values; `null` when the attribute is absent, `""` when present but empty. */
  readonly attrs: Readonly<Record<string, string | null>>;
}

/**
 * Scan `html` with the runtime's streaming `HTMLRewriter`, returning — in
 * document order — every element matching `selector` together with the
 * requested attribute values.
 *
 * Using a real tokenizer (rather than regex) means elements inside comments are
 * never reported (the parser treats comment contents as text, satisfying
 * webmention.rocks discovery test 13), attribute quoting is handled correctly,
 * and a `data-href` attribute is never mistaken for `href`. An absent attribute
 * is reported as `null`; a present-but-empty one (`href=""`) as `""`.
 */
export async function scanElements(
  html: string,
  selector: string,
  attrNames: readonly string[],
): Promise<ScannedElement[]> {
  const elements: ScannedElement[] = [];
  const rewriter = new HTMLRewriter().on(selector, {
    element(el) {
      const attrs: Record<string, string | null> = {};
      for (const name of attrNames) {
        // Attribute values arrive raw (entities as written); decode so an
        // href of `…?a=1&amp;b=2` compares equal to the target `…?a=1&b=2`.
        const value = el.getAttribute(name);
        attrs[name] = value === null ? null : decodeEntities(value);
      }
      elements.push({ name: el.tagName, attrs });
    },
  });
  // Drive the parser to completion by consuming the transformed body.
  await rewriter.transform(new Response(html)).text();
  return elements;
}
