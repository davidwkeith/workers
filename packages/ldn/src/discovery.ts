/**
 * LDN inbox discovery — both sides of the wire.
 *
 * A target resource advertises its inbox so a sender can find it. LDN allows the
 * advertisement to travel either in an HTTP `Link` header or as an `ldp:inbox`
 * triple in the resource's RDF body, so this module covers building the header
 * (and triple) on the producer side and parsing both forms on the consumer side.
 *
 * It depends on `@dwk/rdf` for *types only* (erased at build), so it carries no
 * RDF-parser runtime. It is re-exported from the package root and also reachable
 * directly as `@dwk/ldn/discovery`, the n3-free entry point a binding-bound
 * consumer (e.g. a Workers runtime) imports to advertise an inbox without
 * pulling in the notification parser.
 */

import type { StoredQuad } from "@dwk/rdf";

import { LDP_INBOX } from "./vocab";

const DEFAULT_GRAPH = { termType: "DefaultGraph", value: "" } as const;

/**
 * Build the `Link` header value advertising `inboxIri` as the resource's inbox:
 * `<inboxIri>; rel="http://www.w3.org/ns/ldp#inbox"`. Join it with any other
 * link-values using `, ` to form a complete header.
 */
export function inboxLinkHeader(inboxIri: string): string {
  return `<${inboxIri}>; rel="${LDP_INBOX}"`;
}

/**
 * Build the `<subjectIri> ldp:inbox <inboxIri>` triple that advertises the inbox
 * inside a resource's RDF body (the alternative to the `Link` header).
 */
export function inboxTriple(subjectIri: string, inboxIri: string): StoredQuad {
  return {
    subject: { termType: "NamedNode", value: subjectIri },
    predicate: { termType: "NamedNode", value: LDP_INBOX },
    object: { termType: "NamedNode", value: inboxIri },
    graph: DEFAULT_GRAPH,
  };
}

/**
 * Extract the inbox IRIs a graph advertises via `ldp:inbox`. When `subjectIri`
 * is given, only triples with that subject are considered (the usual case: "what
 * is _this_ resource's inbox?"); otherwise every `ldp:inbox` object is returned.
 * Only named-node objects count — a literal `ldp:inbox` is not a dereferenceable
 * inbox. Results are de-duplicated, preserving first-seen order.
 */
export function discoverInboxIris(
  quads: readonly StoredQuad[],
  subjectIri?: string,
): string[] {
  const found = new Set<string>();
  for (const quad of quads) {
    if (quad.predicate.value !== LDP_INBOX) continue;
    if (quad.object.termType !== "NamedNode") continue;
    if (subjectIri !== undefined && quad.subject.value !== subjectIri) continue;
    found.add(quad.object.value);
  }
  return [...found];
}

/**
 * Parse the inbox IRIs advertised by an HTTP `Link` header. A link-value counts
 * when its `rel` token list includes the full `ldp:inbox` IRI (LDN's canonical
 * form) or the bare `inbox` token. Returns de-duplicated, first-seen-order IRIs;
 * an absent or malformed header yields an empty list.
 */
export function parseInboxLinks(linkHeader: string | null): string[] {
  if (!linkHeader) return [];
  const found = new Set<string>();
  for (const entry of splitLinkValues(linkHeader)) {
    const start = entry.indexOf("<");
    const end = entry.indexOf(">", start + 1);
    if (start === -1 || end === -1) continue;
    const uri = entry.slice(start + 1, end).trim();
    if (uri.length === 0) continue;
    if (linkEntryRelIsInbox(entry.slice(end + 1))) found.add(uri);
  }
  return [...found];
}

/**
 * Split a `Link` header into its individual link-values on top-level commas,
 * tracking both quoted parameter values and `<…>` URI-references so a comma
 * inside either never splits an entry (RFC 8288). A simple `,`-followed-by-`<`
 * regex would mis-split a quoted parameter such as `title="a, <b>"`.
 */
function splitLinkValues(header: string): string[] {
  const values: string[] = [];
  let inQuotes = false;
  let inBrackets = false;
  let current = "";
  for (let i = 0; i < header.length; i++) {
    const char = header[i] as string;
    if (char === '"' && header[i - 1] !== "\\") {
      inQuotes = !inQuotes;
    } else if (char === "<" && !inQuotes) {
      inBrackets = true;
    } else if (char === ">" && !inQuotes) {
      inBrackets = false;
    }
    if (char === "," && !inQuotes && !inBrackets) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") values.push(current);
  return values;
}

/**
 * Whether a link-value's parameter string declares `rel` naming the inbox. `rel`
 * is a space-separated token list, so `rel="http://www.w3.org/ns/ldp#inbox"` and
 * `rel="inbox alternate"` both count. Parameters are split on top-level `;`
 * (respecting quotes) so a `rel=...` substring inside another quoted parameter
 * value is not mistaken for the rel parameter.
 */
function linkEntryRelIsInbox(params: string): boolean {
  for (const param of splitLinkParams(params)) {
    const match = /^\s*rel\s*=\s*("([^"]*)"|'([^']*)'|[^;\s]+)\s*$/i.exec(
      param,
    );
    if (match === null) continue;
    const value = match[2] ?? match[3] ?? match[1] ?? "";
    const tokens = value.split(/\s+/);
    if (tokens.includes(LDP_INBOX) || tokens.includes("inbox")) return true;
  }
  return false;
}

/** Split a link-value parameter string on top-level `;`, respecting quotes. */
function splitLinkParams(params: string): string[] {
  const parts: string[] = [];
  let inQuotes = false;
  let current = "";
  for (let i = 0; i < params.length; i++) {
    const char = params[i] as string;
    if (char === '"' && params[i - 1] !== "\\") {
      inQuotes = !inQuotes;
    }
    if (char === ";" && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}
