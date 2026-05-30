import { DataFactory } from "n3";
import { describe, expect, it } from "vitest";

import {
  quadToStored,
  storedToQuad,
  storedToTerm,
  termToStored,
} from "./store";

const { namedNode, blankNode, literal, defaultGraph, quad } = DataFactory;

describe("@dwk/rdf store helpers", () => {
  it("round-trips every term type", () => {
    const terms = [
      namedNode("https://example.com/a"),
      blankNode("b0"),
      literal("plain"),
      literal("42", namedNode("http://www.w3.org/2001/XMLSchema#integer")),
      literal("bonjour", "fr"),
      defaultGraph(),
    ];
    for (const term of terms) {
      const restored = storedToTerm(termToStored(term));
      expect(restored.termType).toBe(term.termType);
      expect(restored.value).toBe(term.value);
    }
  });

  it("preserves datatype and language on literals", () => {
    const typed = termToStored(
      literal("42", namedNode("http://www.w3.org/2001/XMLSchema#integer")),
    );
    expect(typed.datatype).toBe("http://www.w3.org/2001/XMLSchema#integer");
    expect(typed.language).toBeUndefined();

    const tagged = termToStored(literal("hola", "es"));
    expect(tagged.language).toBe("es");
    expect(tagged.datatype).toBeUndefined();

    const restored = storedToTerm(tagged);
    expect(restored.termType).toBe("Literal");
    expect((restored as ReturnType<typeof literal>).language).toBe("es");
  });

  it("round-trips a full quad including a named graph", () => {
    const original = quad(
      namedNode("https://example.com/s"),
      namedNode("https://example.com/p"),
      literal("o", "en"),
      namedNode("https://example.com/g"),
    );
    const stored = quadToStored(original);
    expect(stored.graph.value).toBe("https://example.com/g");

    const restored = storedToQuad(stored);
    expect(restored.equals(original)).toBe(true);
  });

  it("defaults a datatype-less, language-less literal to xsd:string", () => {
    const restored = storedToTerm({ termType: "Literal", value: "x" });
    expect(restored.termType).toBe("Literal");
    expect((restored as ReturnType<typeof literal>).datatype.value).toBe(
      "http://www.w3.org/2001/XMLSchema#string",
    );
  });

  it("round-trips a default-graph quad", () => {
    const original = quad(
      blankNode("x"),
      namedNode("https://example.com/p"),
      namedNode("https://example.com/o"),
    );
    const restored = storedToQuad(quadToStored(original));
    expect(restored.graph.termType).toBe("DefaultGraph");
    expect(restored.equals(original)).toBe(true);
  });
});
