/**
 * Incremental tokenizer for the `@dwk/esi` v1 tag subset
 * (`esi:include`, `esi:comment`, `esi:remove`).
 */

const TAG_PREFIX = "<esi:";
const REMOVE_CLOSE_TAG = "</esi:remove>";
const MAX_PENDING_BYTES = 8192;
const byteCounter = new TextEncoder();

/**
 * UTF-8 byte length of `s`. A JS string's own `.length` counts UTF-16 code
 * units, which undercounts multi-byte characters (e.g. a 3-byte CJK
 * character is 1 UTF-16 unit) — measuring pending-tag size against
 * {@link MAX_PENDING_BYTES} with `.length` would let an attacker-controlled
 * unterminated tag grow well past the nominal byte cap by filling it with
 * multi-byte text.
 */
function byteLength(s: string): number {
  return byteCounter.encode(s).length;
}

export type EsiToken =
  | { readonly kind: "text"; readonly value: string }
  | {
      readonly kind: "include";
      readonly src: string;
      readonly alt?: string;
      readonly onerror?: "continue";
    }
  | { readonly kind: "remove-block" };
// esi:comment is consumed and dropped by the tokenizer itself — it never
// becomes a token, since it never contributes to output either way. Same
// for the *contents* of an esi:remove block: only a marker token is
// produced (see the #removing streaming-discard mode below); the block's
// own text is never buffered as a whole, so it can be arbitrarily large.

type TagParseResult =
  | "incomplete"
  | {
      readonly consumed: number;
      readonly token: EsiToken | null;
      /** True when an esi:remove block was opened and its (unbounded)
       *  contents must now be streamed-and-discarded rather than buffered. */
      readonly startRemoving?: true;
    };

/**
 * Incremental tokenizer: feed it chunks of decoded text via `push`, get
 * back any tokens that are now fully resolved (i.e. not mid-tag). Call
 * `flush()` at end-of-stream to emit any trailing plain text (an
 * unterminated `<esi:...` tag at end-of-stream degrades to literal text,
 * never throws).
 */
export class EsiTokenizer {
  #buffer = "";
  // True while inside an <esi:remove>...</esi:remove> block whose closing
  // tag hasn't been seen yet. Content while in this mode is discarded as it
  // arrives (never buffered as a whole), so a remove block of any size costs
  // only the closing tag's own length in pending memory.
  #removing = false;

  push(chunk: string): EsiToken[] {
    this.#buffer += chunk;
    return this.#drain(false);
  }

  flush(): EsiToken[] {
    const tokens = this.#drain(true);
    if (!this.#removing && this.#buffer.length > 0) {
      tokens.push({ kind: "text", value: this.#buffer });
    }
    this.#buffer = "";
    return tokens;
  }

  #drain(isFlush: boolean): EsiToken[] {
    const tokens: EsiToken[] = [];
    for (;;) {
      if (this.#removing) {
        const closeIdx = this.#buffer.indexOf(REMOVE_CLOSE_TAG);
        if (closeIdx !== -1) {
          this.#buffer = this.#buffer.slice(closeIdx + REMOVE_CLOSE_TAG.length);
          this.#removing = false;
          continue;
        }
        if (isFlush) {
          this.#buffer = "";
          break;
        }
        // Keep only a trailing partial match of the close tag (it may be
        // split across a chunk boundary); discard everything else.
        const partial = longestPrefixOverlap(this.#buffer, REMOVE_CLOSE_TAG);
        this.#buffer =
          partial > 0 ? this.#buffer.slice(this.#buffer.length - partial) : "";
        break;
      }

      const idx = this.#buffer.indexOf(TAG_PREFIX);
      if (idx === -1) {
        if (isFlush) {
          break;
        }
        const partial = longestPrefixOverlap(this.#buffer, TAG_PREFIX);
        const safeLen = this.#buffer.length - partial;
        if (safeLen > 0) {
          tokens.push({ kind: "text", value: this.#buffer.slice(0, safeLen) });
        }
        this.#buffer = this.#buffer.slice(safeLen);
        break;
      }

      if (idx > 0) {
        tokens.push({ kind: "text", value: this.#buffer.slice(0, idx) });
      }

      const candidate = this.#buffer.slice(idx);
      const result = tryParseTag(candidate);
      if (result === "incomplete") {
        if (isFlush) {
          tokens.push({ kind: "text", value: candidate });
          this.#buffer = "";
          break;
        }
        if (byteLength(candidate) > MAX_PENDING_BYTES) {
          tokens.push({ kind: "text", value: candidate });
          this.#buffer = "";
          break;
        }
        this.#buffer = candidate;
        break;
      }

      if (result.startRemoving) {
        if (result.token) {
          tokens.push(result.token);
        }
        this.#removing = true;
        this.#buffer = candidate.slice(result.consumed);
        continue;
      }

      if (result.token) {
        tokens.push(result.token);
      }
      this.#buffer = candidate.slice(result.consumed);
    }
    return tokens;
  }
}

function longestPrefixOverlap(buffer: string, marker: string): number {
  const maxLen = Math.min(buffer.length, marker.length - 1);
  for (let len = maxLen; len > 0; len--) {
    if (buffer.endsWith(marker.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

function findTagEnd(s: string, from: number): number {
  let inQuote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function parseAttributes(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const name = m[1];
    const value = m[2] !== undefined ? m[2] : m[3];
    if (name !== undefined && value !== undefined) {
      attrs[name] = value;
    }
  }
  return attrs;
}

function tryParseTag(s: string): TagParseResult {
  let i = TAG_PREFIX.length;
  while (i < s.length && /[a-zA-Z-]/.test(s[i]!)) {
    i++;
  }
  if (i === s.length) {
    return "incomplete";
  }
  const tagName = s.slice(TAG_PREFIX.length, i);

  if (tagName === "include") {
    const end = findTagEnd(s, i);
    if (end === -1) {
      return "incomplete";
    }
    const consumed = end + 1;
    let inner = s.slice(i, end);
    if (inner.endsWith("/")) {
      inner = inner.slice(0, -1);
    }
    const attrs = parseAttributes(inner);
    if (!attrs.src) {
      return { consumed, token: { kind: "text", value: s.slice(0, consumed) } };
    }
    const token: EsiToken = {
      kind: "include",
      src: attrs.src,
      ...(attrs.alt !== undefined ? { alt: attrs.alt } : {}),
      ...(attrs.onerror === "continue" ? { onerror: "continue" as const } : {}),
    };
    return { consumed, token };
  }

  if (tagName === "comment") {
    const end = findTagEnd(s, i);
    if (end === -1) {
      return "incomplete";
    }
    return { consumed: end + 1, token: null };
  }

  if (tagName === "remove") {
    const openEnd = findTagEnd(s, i);
    if (openEnd === -1) {
      return "incomplete";
    }
    const selfClosing = s[openEnd - 1] === "/";
    if (selfClosing) {
      return { consumed: openEnd + 1, token: { kind: "remove-block" } };
    }
    return {
      consumed: openEnd + 1,
      token: { kind: "remove-block" },
      startRemoving: true,
    };
  }

  // Unknown/malformed <esi:...> markup: degrade to literal passthrough text.
  const end = findTagEnd(s, i);
  if (end === -1) {
    return "incomplete";
  }
  const consumed = end + 1;
  return { consumed, token: { kind: "text", value: s.slice(0, consumed) } };
}
