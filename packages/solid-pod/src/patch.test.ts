import type { StoredQuad, StoredTerm } from "@dwk/rdf";
import { describe, expect, it } from "vitest";

import {
  parsePatch,
  PatchConstraintError,
  PatchProblem,
  resolvePatch,
} from "./patch";

const EX = "http://example.org/";
const BASE = "https://pod.example/card";
const DEFAULT_GRAPH: StoredTerm = { termType: "DefaultGraph", value: "" };

function quad(s: string, p: string, o: StoredTerm): StoredQuad {
  return {
    subject: { termType: "NamedNode", value: s },
    predicate: { termType: "NamedNode", value: p },
    object: o,
    graph: DEFAULT_GRAPH,
  };
}

const literal = (value: string): StoredTerm => ({
  termType: "Literal",
  value,
  datatype: "http://www.w3.org/2001/XMLSchema#string",
});

describe("@dwk/solid-pod N3 Patch parsing", () => {
  it("parses where/deletes/inserts formulae", () => {
    const patch = parsePatch(
      `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p a solid:InsertDeletePatch ;
  solid:where   { <${EX}me> ex:name "Old" . } ;
  solid:deletes { <${EX}me> ex:name "Old" . } ;
  solid:inserts { <${EX}me> ex:name "New" . } .`,
      "text/n3",
      BASE,
    );
    expect(patch.where).toHaveLength(1);
    expect(patch.deletes).toHaveLength(1);
    expect(patch.inserts).toHaveLength(1);
  });

  it("resolves a single binding and instantiates variables", () => {
    const patch = parsePatch(
      `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p a solid:InsertDeletePatch ;
   solid:where   { ?s ex:name "Old" . } ;
   solid:deletes { ?s ex:name "Old" . } ;
   solid:inserts { ?s ex:name "New" . } .`,
      "text/n3",
      BASE,
    );
    const current = [quad(`${EX}me`, `${EX}name`, literal("Old"))];
    const resolved = resolvePatch(patch, current);
    expect(resolved.insertOnly).toBe(false);
    expect(resolved.inserts[0]?.object).toMatchObject({ value: "New" });
    expect(resolved.deletes[0]?.subject.value).toBe(`${EX}me`);
  });

  it("throws no_match when where does not bind", () => {
    const patch = parsePatch(
      `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p a solid:InsertDeletePatch ;
   solid:where { ?s ex:name "Missing" . } ;
   solid:inserts { ?s ex:name "New" . } .`,
      "text/n3",
      BASE,
    );
    expect(() => resolvePatch(patch, [])).toThrow(PatchProblem);
    try {
      resolvePatch(patch, []);
    } catch (e) {
      expect((e as PatchProblem).code).toBe("no_match");
    }
  });

  it("throws ambiguous_match when where binds more than once", () => {
    const patch = parsePatch(
      `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p a solid:InsertDeletePatch ;
   solid:where { ?s ex:kind "person" . } ;
   solid:inserts { ?s ex:seen "yes" . } .`,
      "text/n3",
      BASE,
    );
    const current = [
      quad(`${EX}a`, `${EX}kind`, literal("person")),
      quad(`${EX}b`, `${EX}kind`, literal("person")),
    ];
    expect(() => resolvePatch(patch, current)).toThrow(/ambiguous/);
  });

  it("throws where_too_complex when the pattern has too many triples", () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `   ?s ex:p${i} ?o${i} .`,
    ).join("\n");
    const patch = parsePatch(
      `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p a solid:InsertDeletePatch ;
   solid:where {
${lines}
} ;
   solid:inserts { ?s ex:seen "yes" . } .`,
      "text/n3",
      BASE,
    );
    try {
      resolvePatch(patch, []);
      expect.unreachable("expected where_too_complex");
    } catch (e) {
      expect((e as PatchProblem).code).toBe("where_too_complex");
    }
  });

  it("throws where_too_complex when the cartesian product blows the work budget", () => {
    // Several all-variable triples against a moderately sized resource build an
    // N^k intermediate product that exceeds the solver's work budget.
    const patch = parsePatch(
      `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p a solid:InsertDeletePatch ;
   solid:where {
   ?a ?b ?c .
   ?d ?e ?f .
   ?g ?h ?i .
   ?j ?k ?l .
} ;
   solid:inserts { <${EX}me> ex:seen "yes" . } .`,
      "text/n3",
      BASE,
    );
    const current = Array.from({ length: 200 }, (_, i) =>
      quad(`${EX}s${i}`, `${EX}p`, literal(`v${i}`)),
    );
    try {
      resolvePatch(patch, current);
      expect.unreachable("expected where_too_complex");
    } catch (e) {
      expect((e as PatchProblem).code).toBe("where_too_complex");
    }
  });

  it("still resolves a single binding that stays within the work budget", () => {
    // A selective two-triple pattern against many triples binds exactly once
    // and must not be rejected by the DoS guard.
    const patch = parsePatch(
      `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p a solid:InsertDeletePatch ;
   solid:where {
   ?s ex:kind "person" .
   ?s ex:name "Ada" .
} ;
   solid:inserts { ?s ex:seen "yes" . } .`,
      "text/n3",
      BASE,
    );
    const current = [
      ...Array.from({ length: 100 }, (_, i) =>
        quad(`${EX}p${i}`, `${EX}kind`, literal("person")),
      ),
      quad(`${EX}p0`, `${EX}name`, literal("Ada")),
    ];
    const resolved = resolvePatch(patch, current);
    expect(resolved.inserts[0]?.subject.value).toBe(`${EX}p0`);
  });

  it("throws delete_not_found when a delete triple is absent", () => {
    const patch = parsePatch(
      `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p a solid:InsertDeletePatch ;
   solid:deletes { <${EX}me> ex:name "Old" . } .`,
      "text/n3",
      BASE,
    );
    expect(() => resolvePatch(patch, [])).toThrow(/delete_not_found/);
  });

  it("marks an insert-only patch", () => {
    const patch = parsePatch(
      `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p a solid:InsertDeletePatch ;
   solid:inserts { <${EX}me> ex:note "hi" . } .`,
      "text/n3",
      BASE,
    );
    expect(resolvePatch(patch, []).insertOnly).toBe(true);
  });
});

describe("@dwk/solid-pod N3 Patch document constraints", () => {
  it("rejects a patch missing the InsertDeletePatch type triple", () => {
    try {
      parsePatch(
        `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p solid:inserts { <${EX}me> ex:note "hi" . } .`,
        "text/n3",
        BASE,
      );
      expect.unreachable("expected missing_type");
    } catch (e) {
      expect(e).toBeInstanceOf(PatchConstraintError);
      expect((e as PatchConstraintError).code).toBe("missing_type");
    }
  });

  it("rejects a blank node in the inserts formula", () => {
    try {
      parsePatch(
        `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p a solid:InsertDeletePatch ;
   solid:inserts { <${EX}me> ex:knows _:someone . } .`,
        "text/n3",
        BASE,
      );
      expect.unreachable("expected blank_node_in_template");
    } catch (e) {
      expect(e).toBeInstanceOf(PatchConstraintError);
      expect((e as PatchConstraintError).code).toBe("blank_node_in_template");
    }
  });

  it("rejects more than one solid:where statement", () => {
    try {
      parsePatch(
        `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p a solid:InsertDeletePatch ;
   solid:where { ?s ex:name "A" . } ;
   solid:where { ?s ex:name "B" . } ;
   solid:inserts { ?s ex:seen "yes" . } .`,
        "text/n3",
        BASE,
      );
      expect.unreachable("expected duplicate_predicate");
    } catch (e) {
      expect(e).toBeInstanceOf(PatchConstraintError);
      expect((e as PatchConstraintError).code).toBe("duplicate_predicate");
    }
  });

  it("rejects a template variable that does not occur in where", () => {
    try {
      parsePatch(
        `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <${EX}> .
_:p a solid:InsertDeletePatch ;
   solid:where { ?s ex:name "Old" . } ;
   solid:inserts { ?s ex:friend ?unbound . } .`,
        "text/n3",
        BASE,
      );
      expect.unreachable("expected unbound_template_variable");
    } catch (e) {
      expect(e).toBeInstanceOf(PatchConstraintError);
      expect((e as PatchConstraintError).code).toBe(
        "unbound_template_variable",
      );
    }
  });

  it("rejects malformed N3 as a document constraint violation", () => {
    try {
      parsePatch("@prefix solid: <broken", "text/n3", BASE);
      expect.unreachable("expected parse_error");
    } catch (e) {
      expect(e).toBeInstanceOf(PatchConstraintError);
      expect((e as PatchConstraintError).code).toBe("parse_error");
    }
  });
});

describe("@dwk/solid-pod SPARQL Update parsing", () => {
  it("parses INSERT DATA", () => {
    const patch = parsePatch(
      `PREFIX ex: <${EX}>
INSERT DATA { <${EX}me> ex:name "New" . }`,
      "application/sparql-update",
      BASE,
    );
    expect(patch.inserts).toHaveLength(1);
    expect(resolvePatch(patch, []).insertOnly).toBe(true);
  });

  it("parses DELETE DATA", () => {
    const patch = parsePatch(
      `PREFIX ex: <${EX}>
DELETE DATA { <${EX}me> ex:name "Old" . }`,
      "application/sparql-update",
      BASE,
    );
    expect(patch.deletes).toHaveLength(1);
  });

  it("rejects an unsupported media type", () => {
    expect(() => parsePatch("whatever", "application/json", BASE)).toThrow(
      /unsupported_media_type/,
    );
  });
});
