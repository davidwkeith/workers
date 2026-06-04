/**
 * N3 Patch (`text/n3`) and a minimal `application/sparql-update` parser, plus
 * the deliberately-small `solid:where` matcher.
 *
 * This is **not** a SPARQL engine. `solid:where` is a conjunctive basic graph
 * pattern matched against the resource's current triples; the patch applies
 * only when the pattern binds to **exactly one** solution (per the Solid
 * Protocol's N3 Patch rules). Variables in `solid:deletes` / `solid:inserts`
 * are then instantiated from that single binding. Anything richer (`OPTIONAL`,
 * `FILTER`, property paths, multiple solutions) is out of scope and surfaces as
 * a `409`.
 */

import {
  parseTurtle,
  type Quad,
  type StoredQuad,
  type StoredTerm,
} from "@dwk/rdf";

const SOLID = "http://www.w3.org/ns/solid/terms#";
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const DEFAULT_GRAPH: StoredTerm = { termType: "DefaultGraph", value: "" };

/** A term in a patch template/pattern: a variable, or a concrete RDF term. */
type PatchTerm =
  | { readonly kind: "var"; readonly name: string }
  | { readonly kind: "term"; readonly term: StoredTerm };

/** A triple pattern (subject/predicate/object) from a patch graph. */
interface PatchTriple {
  readonly subject: PatchTerm;
  readonly predicate: PatchTerm;
  readonly object: PatchTerm;
}

/** A parsed patch: the `where` pattern and the `deletes`/`inserts` templates. */
export interface Patch {
  readonly where: readonly PatchTriple[];
  readonly deletes: readonly PatchTriple[];
  readonly inserts: readonly PatchTriple[];
}

/** A concrete delete/insert pair ready to hand to `@dwk/store`. */
export interface ResolvedPatch {
  readonly deletes: readonly StoredQuad[];
  readonly inserts: readonly StoredQuad[];
  /** True when the patch only inserts (authorizable with `acl:Append`). */
  readonly insertOnly: boolean;
}

/** A stable failure code from parsing or applying a patch. */
export type PatchError =
  | "parse_error"
  | "unsupported_media_type"
  | "no_match"
  | "ambiguous_match"
  | "unbound_template_variable"
  | "delete_not_found"
  | "where_too_complex";

export class PatchProblem extends Error {
  constructor(readonly code: PatchError) {
    super(`@dwk/solid-pod: patch ${code}`);
    this.name = "PatchProblem";
  }
}

// ---------------------------------------------------------------------------
// Term conversion
// ---------------------------------------------------------------------------

/** Normalize an N3 term into a {@link PatchTerm}. */
function fromN3Term(term: Quad["object"] | Quad["subject"]): PatchTerm {
  switch (term.termType) {
    case "Variable":
      return { kind: "var", name: term.value };
    case "NamedNode":
      return {
        kind: "term",
        term: { termType: "NamedNode", value: term.value },
      };
    case "BlankNode":
      return {
        kind: "term",
        term: { termType: "BlankNode", value: term.value },
      };
    case "Literal": {
      const literal = term as {
        value: string;
        language: string;
        datatype: { value: string };
      };
      if (literal.language) {
        return {
          kind: "term",
          term: {
            termType: "Literal",
            value: literal.value,
            language: literal.language,
          },
        };
      }
      return {
        kind: "term",
        term: {
          termType: "Literal",
          value: literal.value,
          datatype: literal.datatype.value,
        },
      };
    }
    default:
      throw new PatchProblem("parse_error");
  }
}

function tripleFromQuad(quad: Quad): PatchTriple {
  return {
    subject: fromN3Term(quad.subject),
    predicate: fromN3Term(quad.predicate),
    object: fromN3Term(quad.object),
  };
}

// ---------------------------------------------------------------------------
// N3 Patch parsing
// ---------------------------------------------------------------------------

/** Collect the inner triples of the formula referenced by `(subject, predicate)`. */
function formulaTriples(quads: Quad[], predicateIri: string): PatchTriple[] {
  // The statement `_:patch solid:<predicate> { … }` references the formula as a
  // blank-node graph; N3.js emits the formula's triples with that graph term.
  const graphValues = new Set<string>();
  for (const q of quads) {
    if (
      q.predicate.value === predicateIri &&
      q.graph.termType === "DefaultGraph"
    ) {
      if (q.object.termType === "BlankNode") graphValues.add(q.object.value);
    }
  }
  const triples: PatchTriple[] = [];
  for (const q of quads) {
    if (q.graph.termType !== "DefaultGraph" && graphValues.has(q.graph.value)) {
      triples.push(tripleFromQuad(q));
    }
  }
  return triples;
}

/** Parse an N3 Patch document (`text/n3`). */
function parseN3Patch(body: string, baseIRI: string): Patch {
  let quads: Quad[];
  try {
    quads = parseTurtle(body, { format: "text/n3", baseIRI });
  } catch {
    throw new PatchProblem("parse_error");
  }
  return {
    where: formulaTriples(quads, `${SOLID}where`),
    deletes: formulaTriples(quads, `${SOLID}deletes`),
    inserts: formulaTriples(quads, `${SOLID}inserts`),
  };
}

// ---------------------------------------------------------------------------
// Minimal SPARQL Update parsing
// ---------------------------------------------------------------------------

/**
 * Extract `PREFIX`/`BASE` (and `@prefix`/`@base`) declaration lines verbatim.
 *
 * Turtle 1.1 (which N3.js parses) accepts SPARQL-style `PREFIX`/`BASE` without
 * the leading `@` or a trailing `.`, so the lines are passed through as-is and
 * prepended to each pattern block before parsing.
 */
function prologue(body: string): string {
  const matches = body.match(
    /^[ \t]*(?:PREFIX|BASE|@prefix|@base)\b[^\n]*$/gim,
  );
  return matches ? matches.join("\n") : "";
}

/** Pull the contents of the first `KEYWORD { … }` block (brace-matched). */
function block(body: string, keyword: RegExp): string | null {
  const m = keyword.exec(body);
  if (!m) return null;
  const open = body.indexOf("{", m.index + m[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return body.slice(open + 1, i);
  }
  return null;
}

function parsePatternBlock(
  content: string,
  prefixes: string,
  baseIRI: string,
): PatchTriple[] {
  try {
    const quads = parseTurtle(`${prefixes}\n${content}`, {
      format: "text/n3",
      baseIRI,
    });
    return quads
      .filter((q) => q.graph.termType === "DefaultGraph")
      .map(tripleFromQuad);
  } catch {
    throw new PatchProblem("parse_error");
  }
}

/** Parse the supported subset of `application/sparql-update`. */
function parseSparqlUpdate(body: string, baseIRI: string): Patch {
  const prefixes = prologue(body);
  const insertData = block(body, /INSERT\s+DATA\s*/i);
  const deleteData = block(body, /DELETE\s+DATA\s*/i);
  if (insertData !== null || deleteData !== null) {
    return {
      where: [],
      inserts: insertData
        ? parsePatternBlock(insertData, prefixes, baseIRI)
        : [],
      deletes: deleteData
        ? parsePatternBlock(deleteData, prefixes, baseIRI)
        : [],
    };
  }

  const where = block(body, /WHERE\s*/i);
  const deletes = block(body, /DELETE\s*/i);
  const inserts = block(body, /INSERT\s*/i);
  if (where === null && deletes === null && inserts === null) {
    throw new PatchProblem("parse_error");
  }
  return {
    where: where ? parsePatternBlock(where, prefixes, baseIRI) : [],
    deletes: deletes ? parsePatternBlock(deletes, prefixes, baseIRI) : [],
    inserts: inserts ? parsePatternBlock(inserts, prefixes, baseIRI) : [],
  };
}

/** Parse a patch body by its `Content-Type`. */
export function parsePatch(
  body: string,
  contentType: string,
  baseIRI: string,
): Patch {
  const essence = contentType.split(";")[0]?.trim().toLowerCase();
  if (essence === "text/n3" || essence === "application/n3") {
    return parseN3Patch(body, baseIRI);
  }
  if (
    essence === "application/sparql-update" ||
    essence === "application/sparql-update; charset=utf-8"
  ) {
    return parseSparqlUpdate(body, baseIRI);
  }
  throw new PatchProblem("unsupported_media_type");
}

// ---------------------------------------------------------------------------
// where-matching
// ---------------------------------------------------------------------------

type Bindings = ReadonlyMap<string, StoredTerm>;

/**
 * DoS guards for the `where` solver. This is a minimal conjunctive matcher, not
 * a SPARQL engine, and it runs inside the single-threaded per-pod Durable
 * Object — so a crafted patch with several all-variable `where` triples against
 * a large resource could otherwise build an N^k cartesian product and exhaust
 * the CPU budget, stalling every request that serializes through that pod.
 *
 * `MAX_WHERE_TRIPLES` caps the pattern size, and `MAX_SOLVE_WORK` caps the
 * total candidate-match attempts across all triples — together they bound the
 * solver's cost regardless of resource size. Exceeding either is reported as
 * {@link PatchProblem} `where_too_complex`.
 */
const MAX_WHERE_TRIPLES = 25;
const MAX_SOLVE_WORK = 1_000_000;

/** Normalize a literal's datatype: an untyped, non-language literal is xsd:string. */
function effectiveDatatype(term: StoredTerm): string | undefined {
  if (term.termType !== "Literal") return undefined;
  if (term.language) return undefined;
  return term.datatype ?? XSD_STRING;
}

/** Strict term equality, normalizing the implicit xsd:string datatype. */
function termsEqual(a: StoredTerm, b: StoredTerm): boolean {
  if (a.termType !== b.termType || a.value !== b.value) return false;
  if (a.termType === "Literal") {
    return (
      (a.language ?? "") === (b.language ?? "") &&
      effectiveDatatype(a) === effectiveDatatype(b)
    );
  }
  return true;
}

/** Match one pattern term against a concrete term under `bindings`. */
function matchTerm(
  pattern: PatchTerm,
  value: StoredTerm,
  bindings: Map<string, StoredTerm>,
): boolean {
  if (pattern.kind === "var") {
    const bound = bindings.get(pattern.name);
    if (bound) return termsEqual(bound, value);
    bindings.set(pattern.name, value);
    return true;
  }
  return termsEqual(pattern.term, value);
}

/**
 * Find solutions of the conjunctive `where` pattern against `current`, via
 * straightforward backtracking. Each solution is a complete variable binding.
 *
 * Bounded against pattern-driven CPU exhaustion (see {@link MAX_WHERE_TRIPLES}
 * and {@link MAX_SOLVE_WORK}): an over-large pattern, or one whose intermediate
 * cartesian product blows the work budget, throws `where_too_complex` rather
 * than enumerating it. Resolution only needs to distinguish "no bind", "exactly
 * one bind", and "more than one bind", so the result is capped at two solutions
 * — that is enough to detect ambiguity without materializing every binding.
 */
function solve(
  where: readonly PatchTriple[],
  current: readonly StoredQuad[],
): Bindings[] {
  if (where.length === 0) return [new Map()];
  if (where.length > MAX_WHERE_TRIPLES) {
    throw new PatchProblem("where_too_complex");
  }

  let work = 0;
  let solutions: Map<string, StoredTerm>[] = [new Map()];
  for (let i = 0; i < where.length; i++) {
    const triple = where[i] as PatchTriple;
    const last = i === where.length - 1;
    const next: Map<string, StoredTerm>[] = [];
    for (const partial of solutions) {
      for (const quad of current) {
        if (++work > MAX_SOLVE_WORK) {
          throw new PatchProblem("where_too_complex");
        }
        const candidate = new Map(partial);
        if (
          matchTerm(triple.subject, quad.subject, candidate) &&
          matchTerm(triple.predicate, quad.predicate, candidate) &&
          matchTerm(triple.object, quad.object, candidate)
        ) {
          next.push(candidate);
          // On the final triple, two complete solutions already prove the
          // match is ambiguous; stop before enumerating the rest.
          if (last && next.length > 1) return next;
        }
      }
    }
    if (next.length === 0) return [];
    solutions = next;
  }
  return solutions;
}

/** Instantiate a template term under a binding into a concrete {@link StoredTerm}. */
function instantiate(term: PatchTerm, bindings: Bindings): StoredTerm {
  if (term.kind === "var") {
    const bound = bindings.get(term.name);
    if (!bound) throw new PatchProblem("unbound_template_variable");
    return bound;
  }
  return term.term;
}

function instantiateTriple(
  triple: PatchTriple,
  bindings: Bindings,
): StoredQuad {
  return {
    subject: instantiate(triple.subject, bindings),
    predicate: instantiate(triple.predicate, bindings),
    object: instantiate(triple.object, bindings),
    graph: DEFAULT_GRAPH,
  };
}

/** Whether `current` contains a quad equal to `target` (default graph). */
function contains(current: readonly StoredQuad[], target: StoredQuad): boolean {
  return current.some(
    (q) =>
      termsEqual(q.subject, target.subject) &&
      termsEqual(q.predicate, target.predicate) &&
      termsEqual(q.object, target.object),
  );
}

/**
 * Resolve a parsed {@link Patch} against the resource's `current` quads into a
 * concrete delete/insert pair.
 *
 * @throws {PatchProblem}
 *  - `no_match` when `where` binds to no solution;
 *  - `ambiguous_match` when it binds to more than one;
 *  - `delete_not_found` when a resolved delete triple is absent;
 *  - `unbound_template_variable` when a template uses an unbound variable;
 *  - `where_too_complex` when the `where` pattern exceeds the solver's bounds.
 */
export function resolvePatch(
  patch: Patch,
  current: readonly StoredQuad[],
): ResolvedPatch {
  const solutions = solve(patch.where, current);
  if (solutions.length === 0) throw new PatchProblem("no_match");
  if (solutions.length > 1) throw new PatchProblem("ambiguous_match");
  const bindings = solutions[0] as Bindings;

  const deletes = patch.deletes.map((t) => instantiateTriple(t, bindings));
  const inserts = patch.inserts.map((t) => instantiateTriple(t, bindings));

  for (const d of deletes) {
    if (!contains(current, d)) throw new PatchProblem("delete_not_found");
  }

  return { deletes, inserts, insertOnly: deletes.length === 0 };
}
