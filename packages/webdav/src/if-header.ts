/**
 * A strict, documented subset of the RFC 4918 §10.4 `If:` header — spec §4.
 *
 * The full `If:` grammar (tagged + untagged lists, multiple state tokens, `Not`)
 * is a classic source of parser-differential bugs. The façade supports only what
 * the TOCTOU-free precondition path needs — a **single untagged list of one lock
 * token and/or one ETag** — and answers anything more complex as `unsupported`
 * (the caller returns 400/412 rather than best-effort guessing).
 */

/** The precondition extracted from a supported `If:` header. */
export interface IfHeaderCondition {
  /** `opaquelocktoken:…` / `urn:…` Coded-URL from a `<…>` production. */
  readonly lockToken?: string;
  /** ETag from a `[…]` production, including its surrounding quotes. */
  readonly etag?: string;
}

export type IfHeaderResult =
  | { readonly kind: "none" }
  | { readonly kind: "supported"; readonly condition: IfHeaderCondition }
  | { readonly kind: "unsupported" };

/**
 * Parse an `If:` header value.
 *
 * @returns `none` when absent/empty, `supported` with the single lock token
 *   and/or ETag, or `unsupported` for any construct outside the subset.
 */
export function parseIfHeader(
  header: string | null | undefined,
): IfHeaderResult {
  if (header == null) return { kind: "none" };
  const trimmed = header.trim();
  if (trimmed === "") return { kind: "none" };

  // Only a single untagged No-tag-list "( … )" is supported. A tagged list
  // ("<resource> ( … )") or multiple groups fall outside the subset.
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    return { kind: "unsupported" };
  }
  const inner = trimmed.slice(1, -1);
  if (inner.includes("(") || inner.includes(")")) {
    return { kind: "unsupported" };
  }

  let lockToken: string | undefined;
  let etag: string | undefined;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "<") {
      const end = inner.indexOf(">", i + 1);
      if (end === -1 || lockToken !== undefined) return { kind: "unsupported" };
      lockToken = inner.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === "[") {
      const end = inner.indexOf("]", i + 1);
      if (end === -1 || etag !== undefined) return { kind: "unsupported" };
      let raw = inner.slice(i + 1, end).trim();
      // Weak validators compare equal to their strong form for our purposes.
      if (raw.startsWith("W/")) raw = raw.slice(2).trim();
      etag = raw;
      i = end + 1;
      continue;
    }
    // A bare word ("Not", a state-token keyword, …) is outside the subset.
    return { kind: "unsupported" };
  }

  if (lockToken === undefined && etag === undefined) {
    return { kind: "unsupported" };
  }
  return {
    kind: "supported",
    condition: {
      ...(lockToken !== undefined ? { lockToken } : {}),
      ...(etag !== undefined ? { etag } : {}),
    },
  };
}
