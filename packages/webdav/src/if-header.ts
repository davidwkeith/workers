/**
 * A bounded RFC 4918 §10.4 `If:` header parser — spec §4.
 *
 * The full grammar is small but a classic source of parser-differential bugs,
 * so this parser is strict and bounded rather than best-effort: a fixed cap on
 * lists and conditions, only the documented productions (resource tag, `Not`,
 * `<state-token>`, `[etag]`), and anything else answers `unsupported` (the
 * caller returns 400 rather than guessing). The litmus `locks` group exercises
 * the whole surface: untagged and tagged lists, multiple OR'd lists, `Not`,
 * and the `DAV:no-lock` never-matches token (`cond_put_with_not`,
 * `complex_cond_put`, `fail_cond_put_unlocked`).
 *
 * Evaluation semantics (the router's job, `evaluateIf`): the header is a
 * precondition — true iff at least one list has every condition true — and,
 * independently, every `<state-token>` it names positively counts as
 * *submitted* for lock enforcement (RFC 4918 §7.1).
 */

/** One condition inside a list: `[Not] (<state-token> | [etag])`. */
export interface IfCondition {
  /** Whether the condition is negated (`Not`). */
  readonly not: boolean;
  /** `opaquelocktoken:…` / `DAV:no-lock` Coded-URL from a `<…>` production. */
  readonly lockToken?: string;
  /** ETag from a `[…]` production, including its surrounding quotes. */
  readonly etag?: string;
}

/** One parenthesised list, optionally applying to a tagged resource. */
export interface IfList {
  /**
   * The resource a tagged list names (`<uri>` before the list), verbatim.
   * Untagged lists apply to the request-URI.
   */
  readonly resourceTag?: string;
  readonly conditions: readonly IfCondition[];
}

export type IfHeaderResult =
  | { readonly kind: "none" }
  | { readonly kind: "lists"; readonly lists: readonly IfList[] }
  | { readonly kind: "unsupported" };

/** DoS bound: more lists/conditions than any real client sends is refused. */
const MAX_LISTS = 8;
const MAX_CONDITIONS = 8;

/**
 * Parse an `If:` header value.
 *
 * @returns `none` when absent/empty, `lists` with the parsed condition lists,
 *   or `unsupported` for anything outside the bounded grammar.
 */
export function parseIfHeader(
  header: string | null | undefined,
): IfHeaderResult {
  if (header == null) return { kind: "none" };
  const src = header.trim();
  if (src === "") return { kind: "none" };

  const lists: IfList[] = [];
  let resourceTag: string | undefined;
  let i = 0;

  const skipSpace = () => {
    while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  };

  while (i < src.length) {
    skipSpace();
    if (i >= src.length) break;
    const c = src[i];
    if (c === "<") {
      // A resource tag scopes every following list until the next tag.
      const end = src.indexOf(">", i + 1);
      if (end === -1) return { kind: "unsupported" };
      resourceTag = src.slice(i + 1, end);
      i = end + 1;
      skipSpace();
      // A tag must be followed by a list, not another tag or end-of-header.
      if (src[i] !== "(") return { kind: "unsupported" };
      continue;
    }
    if (c === "(") {
      const end = src.indexOf(")", i + 1);
      if (end === -1) return { kind: "unsupported" };
      const inner = src.slice(i + 1, end);
      if (inner.includes("(")) return { kind: "unsupported" };
      const conditions = parseConditions(inner);
      if (conditions === null) return { kind: "unsupported" };
      if (lists.length >= MAX_LISTS) return { kind: "unsupported" };
      lists.push({
        ...(resourceTag !== undefined ? { resourceTag } : {}),
        conditions,
      });
      i = end + 1;
      continue;
    }
    return { kind: "unsupported" };
  }

  if (lists.length === 0) return { kind: "unsupported" };
  return { kind: "lists", lists };
}

/** Parse the inside of one `( … )` list, or `null` when malformed/over-bound. */
function parseConditions(inner: string): readonly IfCondition[] | null {
  const conditions: IfCondition[] = [];
  let i = 0;
  let pendingNot = false;
  while (i < inner.length) {
    const c = inner[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "<") {
      const end = inner.indexOf(">", i + 1);
      if (end === -1) return null;
      if (conditions.length >= MAX_CONDITIONS) return null;
      conditions.push({ not: pendingNot, lockToken: inner.slice(i + 1, end) });
      pendingNot = false;
      i = end + 1;
      continue;
    }
    if (c === "[") {
      const end = inner.indexOf("]", i + 1);
      if (end === -1) return null;
      let raw = inner.slice(i + 1, end).trim();
      // Weak validators compare equal to their strong form for our purposes.
      if (raw.startsWith("W/")) raw = raw.slice(2).trim();
      if (conditions.length >= MAX_CONDITIONS) return null;
      conditions.push({ not: pendingNot, etag: raw });
      pendingNot = false;
      i = end + 1;
      continue;
    }
    // The only bare word the grammar allows is `Not` (case-insensitive per
    // RFC 4918 §10.4.1's ABNF being case-insensitive for literals).
    if (/^not(?=[\s<[])/i.test(inner.slice(i))) {
      if (pendingNot) return null; // `Not Not` is outside the grammar
      pendingNot = true;
      i += 3;
      continue;
    }
    return null;
  }
  if (pendingNot) return null; // trailing `Not` with no condition
  if (conditions.length === 0) return null; // `()` — "List" requires ≥ 1
  return conditions;
}

/**
 * Every lock token the header names positively (not under `Not`), across all
 * lists — the set "submitted" for RFC 4918 §7.1 lock enforcement. Using a
 * locked resource requires presenting its token affirmatively; naming a token
 * only under `Not` is not a submission.
 */
export function submittedLockTokens(result: IfHeaderResult): readonly string[] {
  if (result.kind !== "lists") return [];
  const tokens: string[] = [];
  for (const list of result.lists) {
    for (const condition of list.conditions) {
      if (!condition.not && condition.lockToken !== undefined) {
        tokens.push(condition.lockToken);
      }
    }
  }
  return tokens;
}
