import { DataFactory } from "n3";
import type { Quad, Quad_Graph, Quad_Object, Term } from "n3";

/**
 * Triple ↔ store helpers.
 *
 * The quad store in `@dwk/store` (DO-SQLite) and `@dwk/solid-pod` content
 * negotiation need a flat, JSON-serializable representation of RDF terms that
 * maps cleanly onto SQLite columns and survives a structured-clone boundary.
 * These helpers convert between N3.js / RDF-JS {@link Quad}s and that
 * representation without pulling in any storage backend.
 */

/** RDF term kinds representable in the store. */
export type StoredTermType =
  | "NamedNode"
  | "BlankNode"
  | "Literal"
  | "DefaultGraph";

/** Flat, JSON-serializable representation of a single RDF term. */
export interface StoredTerm {
  readonly termType: StoredTermType;
  /** Lexical value: IRI, blank-node label, literal value, or `""` for the default graph. */
  readonly value: string;
  /** Literals only: the datatype IRI (omitted for `rdf:langString`). */
  readonly datatype?: string;
  /** Language-tagged literals only: the BCP-47 language tag. */
  readonly language?: string;
}

/** Flat, JSON-serializable representation of a single quad. */
export interface StoredQuad {
  readonly subject: StoredTerm;
  readonly predicate: StoredTerm;
  readonly object: StoredTerm;
  readonly graph: StoredTerm;
}

const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";

/** Convert an RDF term into its flat store representation. */
export function termToStored(term: Term): StoredTerm {
  switch (term.termType) {
    case "NamedNode":
      return { termType: "NamedNode", value: term.value };
    case "BlankNode":
      return { termType: "BlankNode", value: term.value };
    case "DefaultGraph":
      return { termType: "DefaultGraph", value: "" };
    case "Literal":
      return term.language
        ? { termType: "Literal", value: term.value, language: term.language }
        : {
            termType: "Literal",
            value: term.value,
            datatype: term.datatype.value,
          };
    default:
      throw new Error(`@dwk/rdf: cannot store term of type "${term.termType}"`);
  }
}

/** Reconstruct an RDF term from its flat store representation. */
export function storedToTerm(stored: StoredTerm): Term {
  switch (stored.termType) {
    case "NamedNode":
      return DataFactory.namedNode(stored.value);
    case "BlankNode":
      return DataFactory.blankNode(stored.value);
    case "DefaultGraph":
      return DataFactory.defaultGraph();
    case "Literal":
      if (stored.language) {
        return DataFactory.literal(stored.value, stored.language);
      }
      return DataFactory.literal(
        stored.value,
        DataFactory.namedNode(stored.datatype ?? XSD_STRING),
      );
    default:
      throw new Error(
        `@dwk/rdf: unknown stored term type "${String(stored.termType)}"`,
      );
  }
}

/** Convert a quad into its flat store representation. */
export function quadToStored(quad: Quad): StoredQuad {
  return {
    subject: termToStored(quad.subject),
    predicate: termToStored(quad.predicate),
    object: termToStored(quad.object),
    graph: termToStored(quad.graph),
  };
}

/** Reconstruct a quad from its flat store representation. */
export function storedToQuad(stored: StoredQuad): Quad {
  return DataFactory.quad(
    storedToTerm(stored.subject) as Quad["subject"],
    DataFactory.namedNode(stored.predicate.value),
    storedToTerm(stored.object) as Quad_Object,
    storedToTerm(stored.graph) as Quad_Graph,
  );
}
