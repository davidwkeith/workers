/**
 * LDN consumer — inbox listing.
 *
 * A consumer `GET`s an inbox and reads the contained notification IRIs. The
 * inbox is an `ldp:Container` whose members are linked with `ldp:contains`;
 * {@link inboxListingQuads} builds exactly those triples in the flat
 * `StoredQuad` shape so a caller can serialize them with `@dwk/rdf`, and
 * {@link listInboxMembers} reads them back out of a fetched inbox graph.
 */

import type { StoredQuad } from "@dwk/rdf";

import { LDP_CONTAINS, LDP_CONTAINER, RDF_TYPE } from "./vocab";

const DEFAULT_GRAPH = { termType: "DefaultGraph", value: "" } as const;

function namedNode(value: string): StoredQuad["object"] {
  return { termType: "NamedNode", value };
}

/**
 * Build the triples describing an inbox listing: `<inboxIri> a ldp:Container`
 * plus one `<inboxIri> ldp:contains <member>` per notification. Members are
 * de-duplicated, preserving first-seen order.
 */
export function inboxListingQuads(
  inboxIri: string,
  memberIris: Iterable<string>,
): StoredQuad[] {
  const subject = namedNode(inboxIri);
  const quads: StoredQuad[] = [
    {
      subject,
      predicate: namedNode(RDF_TYPE),
      object: namedNode(LDP_CONTAINER),
      graph: DEFAULT_GRAPH,
    },
  ];
  const seen = new Set<string>();
  for (const member of memberIris) {
    if (seen.has(member)) continue;
    seen.add(member);
    quads.push({
      subject,
      predicate: namedNode(LDP_CONTAINS),
      object: namedNode(member),
      graph: DEFAULT_GRAPH,
    });
  }
  return quads;
}

/**
 * Read the notification IRIs an inbox graph contains via `ldp:contains`. When
 * `inboxIri` is given, only that container's members are returned; otherwise
 * every `ldp:contains` object is. Only named-node objects count. Results are
 * de-duplicated, preserving first-seen order.
 */
export function listInboxMembers(
  quads: readonly StoredQuad[],
  inboxIri?: string,
): string[] {
  const found = new Set<string>();
  for (const quad of quads) {
    if (quad.predicate.value !== LDP_CONTAINS) continue;
    if (quad.object.termType !== "NamedNode") continue;
    if (inboxIri !== undefined && quad.subject.value !== inboxIri) continue;
    found.add(quad.object.value);
  }
  return [...found];
}
