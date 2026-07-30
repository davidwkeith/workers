/**
 * Hand-rolled, bounded, XXE-safe XML for WebDAV (RFC 4918) — spec §4.
 *
 * A general-purpose XML library would blow the Worker script-size budget, so —
 * matching the same discipline as the iCalendar emitter and the N3 Patch parser
 * — this is a minimal generator (string templating with strict escaping) plus a
 * bounded recursive-descent parser for the small, known request bodies
 * (`propfind`, `lockinfo`, `propertyupdate`).
 *
 * Hardening (all spec §4):
 * - **XXE guard:** a `DOCTYPE` or any `<!…>` markup declaration is rejected
 *   outright — no entity resolution, ever.
 * - **DoS bounds:** caller-supplied caps on body size and element nesting; over
 *   the bound throws `XmlError` (HTTP 400).
 * - **UTF-8 only:** an XML declaration claiming a non-UTF-8 encoding is rejected
 *   (HTTP 415); the byte-level charset guard lives in the HTTP layer.
 * - **Entities:** only the five predefined entities and numeric character
 *   references decode; anything else is a 400.
 */

export const DAV_NS = "DAV:";

/** A parse/encoding failure carrying the HTTP status the façade should return. */
export class XmlError extends Error {
  readonly status: 400 | 415;

  constructor(message: string, status: 400 | 415 = 400) {
    super(message);
    this.name = "XmlError";
    this.status = status;
  }
}

/** A parsed element. Namespaces are resolved; `ns` is `null` when none applies. */
export interface XmlElement {
  readonly ns: string | null;
  readonly local: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
  /** Concatenated direct text content (text nodes and CDATA), entity-decoded. */
  readonly text: string;
}

/** DoS bounds for {@link parseXml}. */
export interface XmlParseLimits {
  /** Maximum input length (UTF-16 code units); over this throws 400. */
  readonly maxBytes: number;
  /** Maximum element nesting depth; over this throws 400. */
  readonly maxDepth: number;
}

const PREDEFINED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Escape a string for inclusion in XML text or a double-quoted attribute. */
export function escapeXml(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "'":
        out += "&apos;";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  // Any `&` that does not begin a well-formed predefined or numeric reference is
  // malformed — reject rather than pass it through (closes smuggling).
  if (/&(?!#x[0-9a-fA-F]+;|#[0-9]+;|[a-zA-Z][a-zA-Z0-9]*;)/.test(text)) {
    throw new XmlError("malformed XML entity reference");
  }
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (_match, body: string): string => {
      if (body.charCodeAt(0) === 0x23 /* # */) {
        const hex =
          body.charCodeAt(1) === 0x78 /* x */ || body.charCodeAt(1) === 0x58;
        const code = hex
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
          throw new XmlError("invalid numeric character reference");
        }
        return String.fromCodePoint(code);
      }
      const replacement = PREDEFINED[body];
      if (replacement === undefined) {
        throw new XmlError(`undefined XML entity "&${body};"`);
      }
      return replacement;
    },
  );
}

function isNameChar(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) || // A-Z
    (c >= 0x61 && c <= 0x7a) || // a-z
    (c >= 0x30 && c <= 0x39) || // 0-9
    c === 0x3a || // :
    c === 0x5f || // _
    c === 0x2d || // -
    c === 0x2e || // .
    c > 0x7f // any non-ASCII (UTF-8 name char)
  );
}

interface MutableElement {
  ns: string | null;
  local: string;
  attributes: Map<string, string>;
  children: MutableElement[];
  text: string;
}

/**
 * Parse a small WebDAV request body into a resolved element tree.
 *
 * @throws {XmlError} on malformed input, a DoS-bound breach (400), a `DOCTYPE`
 *   (400), or a non-UTF-8 encoding declaration (415).
 */
export function parseXml(input: string, limits: XmlParseLimits): XmlElement {
  if (input.length > limits.maxBytes) {
    throw new XmlError("XML body exceeds the configured size bound");
  }
  // A leading U+FEFF (BOM) survived UTF-8 decoding; drop it.
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let pos = 0;

  const error = (message: string, status: 400 | 415 = 400): never => {
    throw new XmlError(message, status);
  };

  const isSpace = (c: number): boolean =>
    c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

  const skipSpace = (): void => {
    while (pos < src.length && isSpace(src.charCodeAt(pos))) pos++;
  };

  const skipComment = (): void => {
    const end = src.indexOf("-->", pos + 4);
    if (end === -1) error("unterminated XML comment");
    pos = end + 3;
  };

  const skipPi = (): void => {
    const end = src.indexOf("?>", pos + 2);
    if (end === -1) error("unterminated processing instruction");
    pos = end + 2;
  };

  // Skip prolog/epilog miscellany. `<!…>` (DOCTYPE / entity declarations) is the
  // XXE attack surface and is rejected outright.
  const skipMisc = (): void => {
    for (;;) {
      skipSpace();
      if (src.startsWith("<!--", pos)) {
        skipComment();
        continue;
      }
      if (src.startsWith("<!", pos)) {
        error("DOCTYPE and markup declarations are not permitted");
      }
      if (src.startsWith("<?", pos)) {
        skipPi();
        continue;
      }
      break;
    }
  };

  const readName = (): string => {
    const start = pos;
    while (pos < src.length && isNameChar(src.charCodeAt(pos))) pos++;
    if (pos === start) error("expected an XML name");
    return src.slice(start, pos);
  };

  const readAttrValue = (): string => {
    const quote = src.charCodeAt(pos);
    if (quote !== 0x22 /* " */ && quote !== 0x27 /* ' */) {
      error("attribute value must be quoted");
    }
    pos++;
    const start = pos;
    while (pos < src.length && src.charCodeAt(pos) !== quote) pos++;
    if (pos >= src.length) error("unterminated attribute value");
    const raw = src.slice(start, pos);
    pos++; // closing quote
    return decodeEntities(raw);
  };

  const finalize = (
    qname: string,
    rawAttrs: [string, string][],
    scope: Map<string, string>,
    children: MutableElement[],
    text: string,
  ): MutableElement => {
    const colon = qname.indexOf(":");
    const prefix = colon === -1 ? "" : qname.slice(0, colon);
    const local = colon === -1 ? qname : qname.slice(colon + 1);
    let ns: string | null;
    if (prefix === "") {
      // `xmlns=""` legally un-declares the default namespace, so an empty
      // in-scope default is the same as no default: the element is in no
      // namespace (`null`), never the empty string — downstream emitters
      // branch on `null` to serialize such names legally (bare, unprefixed).
      const def = scope.get("");
      ns = def === undefined || def === "" ? null : def;
    } else {
      const resolved = scope.get(prefix);
      if (resolved === undefined) {
        throw new XmlError(`unbound namespace prefix "${prefix}"`);
      }
      ns = resolved;
    }
    const attributes = new Map<string, string>();
    for (const [name, value] of rawAttrs) attributes.set(name, value);
    return { ns, local, attributes, children, text };
  };

  const parseElement = (
    depth: number,
    inherited: Map<string, string>,
  ): MutableElement => {
    if (depth > limits.maxDepth) {
      error("XML nesting exceeds the configured depth bound");
    }
    pos++; // consume "<"
    const qname = readName();
    const rawAttrs: [string, string][] = [];
    const scope = new Map(inherited);
    const seenAttrs = new Set<string>();

    for (;;) {
      skipSpace();
      const c = src.charCodeAt(pos);
      if (c === 0x2f /* / */) {
        pos++;
        if (src.charCodeAt(pos) !== 0x3e /* > */)
          error("malformed empty element");
        pos++;
        return finalize(qname, rawAttrs, scope, [], "");
      }
      if (c === 0x3e /* > */) {
        pos++;
        break;
      }
      if (pos >= src.length) error("unterminated start tag");
      const attrName = readName();
      // XML 1.0 §3.1: an attribute name MUST NOT appear more than once on the
      // same tag. Reject rather than silently overwrite (closes a
      // parser-differential vector); the xmlns/xmlns: declarations count too.
      if (seenAttrs.has(attrName)) error(`duplicate attribute "${attrName}"`);
      seenAttrs.add(attrName);
      skipSpace();
      if (src.charCodeAt(pos) !== 0x3d /* = */) error("malformed attribute");
      pos++;
      skipSpace();
      const attrValue = readAttrValue();
      if (attrName === "xmlns") {
        scope.set("", attrValue);
      } else if (attrName.startsWith("xmlns:")) {
        // XML Namespaces 1.0: a *prefixed* declaration MUST NOT be empty —
        // only the default namespace can be un-declared that way (litmus
        // `propfind_invalid2` requires a 400 here, see the litmus FAQ).
        if (attrValue === "") {
          error(`invalid empty namespace declaration for "${attrName}"`);
        }
        scope.set(attrName.slice(6), attrValue);
      } else {
        rawAttrs.push([attrName, attrValue]);
      }
    }

    const children: MutableElement[] = [];
    let text = "";
    for (;;) {
      if (pos >= src.length) error("unterminated element");
      if (src.startsWith("</", pos)) {
        pos += 2;
        const closeName = readName();
        skipSpace();
        if (src.charCodeAt(pos) !== 0x3e /* > */) error("malformed end tag");
        pos++;
        if (closeName !== qname) error(`mismatched end tag "${closeName}"`);
        break;
      }
      if (src.startsWith("<!--", pos)) {
        skipComment();
        continue;
      }
      if (src.startsWith("<![CDATA[", pos)) {
        const end = src.indexOf("]]>", pos + 9);
        if (end === -1) error("unterminated CDATA section");
        text += src.slice(pos + 9, end);
        pos = end + 3;
        continue;
      }
      if (src.startsWith("<!", pos)) {
        error("DOCTYPE and markup declarations are not permitted");
      }
      if (src.startsWith("<?", pos)) {
        skipPi();
        continue;
      }
      if (src.charCodeAt(pos) === 0x3c /* < */) {
        children.push(parseElement(depth + 1, scope));
        continue;
      }
      const next = src.indexOf("<", pos);
      const end = next === -1 ? src.length : next;
      text += decodeEntities(src.slice(pos, end));
      pos = end;
    }

    return finalize(qname, rawAttrs, scope, children, text);
  };

  skipSpace();
  // Optional XML declaration, only valid at the very start.
  if (src.startsWith("<?xml", pos)) {
    const end = src.indexOf("?>", pos);
    if (end === -1) error("unterminated XML declaration");
    const decl = src.slice(pos, end);
    const encoding = /encoding\s*=\s*["']([^"']*)["']/.exec(decl);
    if (encoding && encoding[1] && encoding[1].toLowerCase() !== "utf-8") {
      error(`unsupported XML encoding "${encoding[1]}"`, 415);
    }
    pos = end + 2;
  }
  skipMisc();
  if (!src.startsWith("<", pos)) error("missing root element");
  const root = parseElement(0, new Map());
  skipMisc();
  if (pos < src.length) error("unexpected content after root element");
  return root;
}

/**
 * Serialize one parsed element with an explicit namespace declaration —
 * `<local xmlns="ns">…</local>`, or bare `<local>` when it is in no namespace —
 * so the fragment stays well-formed pasted into any context with no default
 * namespace in scope (the multistatus emitter only ever declares prefixes).
 */
function serializeElement(element: XmlElement): string {
  const decl = element.ns === null ? "" : ` xmlns="${escapeXml(element.ns)}"`;
  return `<${element.local}${decl}>${serializeFragment(element)}</${element.local}>`;
}

/**
 * Serialize a parsed element's inner content — its text, then its child
 * elements — back to a well-formed XML fragment. This is how a dead property's
 * value (PROPPATCH `<D:set>`) is persisted and later re-emitted by PROPFIND
 * (litmus `propvalnspace`, `prophighunicode`). The parser concatenates direct
 * text and keeps children separately, so a mixed-content value re-serializes
 * with its text first; litmus and real clients store text-only or
 * element-only values, where the order is exact.
 */
export function serializeFragment(element: XmlElement): string {
  return (
    escapeXml(element.text) + element.children.map(serializeElement).join("")
  );
}

/** First direct child with the given namespace + local name, or `undefined`. */
export function firstChild(
  element: XmlElement,
  ns: string | null,
  local: string,
): XmlElement | undefined {
  return element.children.find((c) => c.ns === ns && c.local === local);
}

/** All direct children with the given namespace + local name. */
export function childrenNamed(
  element: XmlElement,
  ns: string | null,
  local: string,
): readonly XmlElement[] {
  return element.children.filter((c) => c.ns === ns && c.local === local);
}
