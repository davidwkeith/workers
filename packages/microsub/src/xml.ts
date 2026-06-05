/**
 * `@dwk/microsub` — a minimal, dependency-free XML reader for feed parsing.
 *
 * Atom and RSS are XML; the Workers runtime exposes `HTMLRewriter` (an HTML
 * tokenizer) but no XML parser, and the non-functional rules forbid pulling a
 * heavy parser into the bundle. This module is a small recursive-descent reader
 * tailored to feeds: elements, attributes, text, `CDATA`, comments, and the
 * predefined/numeric entities — enough to turn a feed document into a tree the
 * JF2 mapper walks. It is **pure** (plain string in, plain tree out) so it
 * unit-tests without a Workers runtime.
 *
 * It is deliberately lenient (feeds in the wild are not always well-formed) and
 * namespace-prefix-preserving but case-folding: element names are lowercased so
 * `content:encoded`, `dc:creator`, and `media:content` match regardless of the
 * source's casing.
 *
 * @packageDocumentation
 */

/** A parsed XML element: its lowercased name, attributes, and child nodes. */
export interface XmlElement {
  readonly type: "element";
  /** Lowercased tag name, prefix included (e.g. `"content:encoded"`). */
  readonly name: string;
  /** Lowercased-key attribute map. */
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

/** A run of character data (already entity-decoded). */
export interface XmlText {
  readonly type: "text";
  readonly value: string;
}

/** A node in the parsed tree. */
export type XmlNode = XmlElement | XmlText;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decode XML predefined and numeric (`&#nn;` / `&#xnn;`) character references. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      const named = NAMED_ENTITIES[body];
      return named ?? whole;
    },
  );
}

interface MutableElement {
  type: "element";
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

/** Parse attributes out of a start-tag's interior (everything after the name). */
function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    const raw = match[3] ?? match[4] ?? match[5] ?? "";
    if (name !== "") attrs[name] = decodeEntities(raw);
  }
  return attrs;
}

/**
 * Parse an XML document into a tree, returning the root element (or `null` when
 * the input contains no element). Comments, the XML declaration, processing
 * instructions, and `DOCTYPE` are skipped; `CDATA` sections become literal text.
 */
export function parseXml(input: string): XmlElement | null {
  const root: MutableElement = {
    type: "element",
    name: "#root",
    attrs: {},
    children: [],
  };
  const stack: MutableElement[] = [root];
  let i = 0;
  const n = input.length;

  const pushText = (value: string): void => {
    if (value === "") return;
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push({ type: "text", value });
  };

  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      pushText(decodeEntities(input.slice(i)));
      break;
    }
    if (lt > i) {
      pushText(decodeEntities(input.slice(i, lt)));
    }

    // Comments, CDATA, DOCTYPE, and declarations all start `<!`.
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      const data = input.slice(lt + 9, end === -1 ? n : end);
      pushText(data); // CDATA is literal — no entity decoding.
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (input[lt + 1] === "!") {
      // DOCTYPE or other declaration: skip to the matching `>`.
      const end = input.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (input[lt + 1] === "?") {
      // Processing instruction / XML declaration.
      const end = input.indexOf("?>", lt);
      i = end === -1 ? n : end + 2;
      continue;
    }

    const gt = input.indexOf(">", lt);
    if (gt === -1) {
      // Unterminated tag — treat the remainder as text and stop.
      pushText(decodeEntities(input.slice(lt)));
      break;
    }
    let tag = input.slice(lt + 1, gt);
    i = gt + 1;

    if (tag[0] === "/") {
      // Close tag: pop to the nearest matching open element.
      const name = tag.slice(1).trim().toLowerCase();
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s]?.name === name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    const selfClosing = tag.endsWith("/");
    if (selfClosing) tag = tag.slice(0, -1);

    const space = tag.search(/\s/);
    const name = (space === -1 ? tag : tag.slice(0, space)).toLowerCase();
    const attrs = space === -1 ? {} : parseAttrs(tag.slice(space + 1));
    const element: MutableElement = {
      type: "element",
      name,
      attrs,
      children: [],
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    if (!selfClosing) stack.push(element);
  }

  const first = root.children.find(
    (node): node is XmlElement => node.type === "element",
  );
  return first ?? null;
}

/** The first direct child element named `name` (case-insensitive). */
export function child(el: XmlElement, name: string): XmlElement | null {
  const lower = name.toLowerCase();
  for (const node of el.children) {
    if (node.type === "element" && node.name === lower) return node;
  }
  return null;
}

/** All direct child elements named `name` (case-insensitive), in order. */
export function children(el: XmlElement, name: string): XmlElement[] {
  const lower = name.toLowerCase();
  const out: XmlElement[] = [];
  for (const node of el.children) {
    if (node.type === "element" && node.name === lower) out.push(node);
  }
  return out;
}

/** Concatenated text of an element's descendants, trimmed. */
export function text(el: XmlElement | null): string {
  if (el === null) return "";
  let out = "";
  const walk = (node: XmlNode): void => {
    if (node.type === "text") {
      out += node.value;
    } else {
      for (const c of node.children) walk(c);
    }
  };
  for (const c of el.children) walk(c);
  return out.trim();
}

/** Text of the first child element named `name`, or `""`. */
export function childText(el: XmlElement, name: string): string {
  return text(child(el, name));
}
