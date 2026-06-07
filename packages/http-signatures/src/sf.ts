/**
 * A focused RFC 8941 structured-fields parser, scoped to the two fields HTTP
 * Message Signatures use: `Signature-Input` (a Dictionary of Inner Lists with
 * parameters) and `Signature` (a Dictionary of Byte Sequences).
 *
 * It is intentionally not a general structured-fields implementation. Parsing
 * is strict — anything malformed throws {@link SfParseError}, which the callers
 * turn into a verification failure rather than guessing at the sender's intent.
 */

/** A structured-fields bare item value, as the native JS shape we use it as. */
export type SfBareItem = string | number | boolean | Uint8Array;

/** One member of an `Signature-Input` inner list (a covered-component id). */
export interface SfInnerItem {
  /** Exact source text of the item (bare item plus its parameters). */
  raw: string;
  /** The bare item, a string for every component identifier we accept. */
  value: SfBareItem;
  /** Item parameters, in source order. */
  params: Array<[string, SfBareItem]>;
}

/** A parsed `Signature-Input` dictionary member. */
export interface SfSignatureInput {
  /** Exact source text of the member value (inner list plus its parameters). */
  raw: string;
  items: SfInnerItem[];
  params: Array<[string, SfBareItem]>;
}

/** Thrown on any malformed structured-field input. */
export class SfParseError extends Error {}

const KEY_START = /[a-z*]/;
const KEY_CHAR = /[a-z0-9_*.-]/;
const TOKEN_START = /[a-zA-Z*]/;
const TOKEN_CHAR = /[a-zA-Z0-9:/!#$%&'*+\-.^_`|~]/;

class Reader {
  pos = 0;
  constructor(readonly input: string) {}

  get done(): boolean {
    return this.pos >= this.input.length;
  }
  peek(): string {
    return this.input[this.pos] ?? "";
  }
  next(): string {
    const c = this.input[this.pos] ?? "";
    this.pos++;
    return c;
  }
  expect(c: string): void {
    if (this.next() !== c) throw new SfParseError(`expected ${c}`);
  }
  skipSP(): void {
    while (this.peek() === " ") this.pos++;
  }
  skipOWS(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }
}

function parseKey(r: Reader): string {
  if (!KEY_START.test(r.peek())) throw new SfParseError("invalid key");
  let key = r.next();
  while (!r.done && KEY_CHAR.test(r.peek())) key += r.next();
  return key;
}

function parseString(r: Reader): string {
  r.expect('"');
  let out = "";
  for (;;) {
    if (r.done) throw new SfParseError("unterminated string");
    const c = r.next();
    if (c === "\\") {
      const esc = r.next();
      if (esc !== '"' && esc !== "\\") throw new SfParseError("bad escape");
      out += esc;
    } else if (c === '"') {
      return out;
    } else {
      const code = c.charCodeAt(0);
      if (code < 0x20 || code >= 0x7f)
        throw new SfParseError("bad string char");
      out += c;
    }
  }
}

function parseToken(r: Reader): string {
  let tok = r.next();
  while (!r.done && TOKEN_CHAR.test(r.peek())) tok += r.next();
  return tok;
}

function parseNumber(r: Reader): number {
  let s = "";
  if (r.peek() === "-") s += r.next();
  while (!r.done && /[0-9.]/.test(r.peek())) s += r.next();
  const n = Number(s);
  if (!Number.isFinite(n)) throw new SfParseError("invalid number");
  return n;
}

function parseByteSequence(r: Reader): Uint8Array {
  r.expect(":");
  let b64 = "";
  while (!r.done && r.peek() !== ":") b64 += r.next();
  r.expect(":");
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new SfParseError("invalid byte sequence");
  }
}

function parseBareItem(r: Reader): SfBareItem {
  const c = r.peek();
  if (c === '"') return parseString(r);
  if (c === ":") return parseByteSequence(r);
  if (c === "?") {
    r.next();
    const b = r.next();
    if (b === "0") return false;
    if (b === "1") return true;
    throw new SfParseError("invalid boolean");
  }
  if (c === "-" || /[0-9]/.test(c)) return parseNumber(r);
  if (TOKEN_START.test(c)) return parseToken(r);
  throw new SfParseError("invalid bare item");
}

function parseParameters(r: Reader): Array<[string, SfBareItem]> {
  const params: Array<[string, SfBareItem]> = [];
  while (r.peek() === ";") {
    r.next();
    r.skipSP();
    const key = parseKey(r);
    let value: SfBareItem = true;
    if (r.peek() === "=") {
      r.next();
      value = parseBareItem(r);
    }
    params.push([key, value]);
  }
  return params;
}

function parseInnerList(r: Reader): {
  items: SfInnerItem[];
  params: Array<[string, SfBareItem]>;
} {
  r.expect("(");
  const items: SfInnerItem[] = [];
  for (;;) {
    r.skipSP();
    if (r.peek() === ")") {
      r.next();
      break;
    }
    if (r.done) throw new SfParseError("unterminated inner list");
    const start = r.pos;
    const value = parseBareItem(r);
    const params = parseParameters(r);
    items.push({ raw: r.input.slice(start, r.pos), value, params });
  }
  const params = parseParameters(r);
  return { items, params };
}

/**
 * Parse a `Signature-Input` header into its labelled inner lists, preserving
 * for each member the exact source text of its value (the `@signature-params`
 * value the base must reproduce byte-for-byte).
 */
export function parseSignatureInput(
  input: string,
): Map<string, SfSignatureInput> {
  const r = new Reader(input);
  const out = new Map<string, SfSignatureInput>();
  r.skipOWS();
  if (r.done) throw new SfParseError("empty dictionary");
  for (;;) {
    const key = parseKey(r);
    if (r.peek() !== "=")
      throw new SfParseError("dictionary member needs a value");
    r.next();
    if (r.peek() !== "(")
      throw new SfParseError("signature-input value must be an inner list");
    const start = r.pos;
    const { items, params } = parseInnerList(r);
    out.set(key, { raw: r.input.slice(start, r.pos), items, params });
    r.skipOWS();
    if (r.done) break;
    r.expect(",");
    r.skipOWS();
  }
  return out;
}

/**
 * Parse an RFC 8941 Dictionary whose member values are Byte Sequences — the
 * shape shared by the `Signature` header and the RFC 9530 `Content-Digest` /
 * `Want-Content-Digest` fields. Member parameters are accepted and discarded.
 * Keys follow sf-key rules (lowercase only), so an uppercase key is a parse
 * error rather than something silently lowercased.
 */
export function parseByteSequenceDictionary(
  input: string,
): Map<string, Uint8Array> {
  const r = new Reader(input);
  const out = new Map<string, Uint8Array>();
  r.skipOWS();
  if (r.done) throw new SfParseError("empty dictionary");
  for (;;) {
    const key = parseKey(r);
    if (r.peek() !== "=")
      throw new SfParseError("dictionary member needs a value");
    r.next();
    const bytes = parseByteSequence(r);
    parseParameters(r);
    out.set(key, bytes);
    r.skipOWS();
    if (r.done) break;
    r.expect(",");
    r.skipOWS();
  }
  return out;
}

/** Parse a `Signature` header into its labelled byte sequences. */
export function parseSignatureHeader(input: string): Map<string, Uint8Array> {
  return parseByteSequenceDictionary(input);
}

/** Serialize an sf-string: double-quoted with `"` and `\` escaped. */
export function serializeString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
