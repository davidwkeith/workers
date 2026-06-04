import { describe, expect, it } from "vitest";

import {
  formatForMediaType,
  parse,
  parseTurtle,
  serialize,
  writeTurtle,
} from "./index";
import type { Quad } from "./index";

/** Order-independent canonical form for comparing quad sets. */
function canonical(quads: Quad[]): string[] {
  return quads
    .map((q) => {
      const o = q.object;
      const lang = o.termType === "Literal" ? o.language : "";
      const dt = o.termType === "Literal" ? o.datatype.value : "";
      return `${q.subject.value} ${q.predicate.value} ${o.value} ${lang} ${dt} ${q.graph.value}`;
    })
    .sort();
}

describe("@dwk/rdf turtle", () => {
  it("round-trips a simple Turtle document", async () => {
    const ttl =
      "<https://example.com/a> <https://example.com/b> <https://example.com/c> .";

    const quads = parseTurtle(ttl);
    expect(quads).toHaveLength(1);
    expect(quads[0]?.subject.value).toBe("https://example.com/a");

    const serialized = await writeTurtle(quads);
    expect(parseTurtle(serialized)).toHaveLength(1);
  });

  it("serializes to N-Triples when asked", async () => {
    const ttl = "@prefix ex: <https://example.com/> . ex:a ex:b ex:c , ex:d .";
    const quads = parseTurtle(ttl);
    const nt = await writeTurtle(quads, { format: "N-Triples" });

    // N-Triples expands every prefix to a full IRI.
    expect(nt).toContain("<https://example.com/a>");
    expect(nt).not.toContain("@prefix");
    expect(parseTurtle(nt, { format: "N-Triples" })).toHaveLength(2);
  });

  it("round-trips quads through TriG named graphs", async () => {
    const trig =
      "@prefix ex: <https://example.com/> . ex:g { ex:a ex:b ex:c . }";
    const quads = parseTurtle(trig, { format: "TriG" });
    expect(quads[0]?.graph.value).toBe("https://example.com/g");

    const out = await writeTurtle(quads, { format: "TriG" });
    const reparsed = parseTurtle(out, { format: "TriG" });
    expect(reparsed[0]?.graph.value).toBe("https://example.com/g");
  });
});

describe("@dwk/rdf content negotiation", () => {
  it("maps media types (with parameters and casing) to formats", () => {
    expect(formatForMediaType("text/turtle")).toBe("Turtle");
    expect(formatForMediaType('application/ld+json; profile="x"')).toBe(
      "JSON-LD",
    );
    expect(formatForMediaType("Application/N-Quads")).toBe("N-Quads");
    expect(formatForMediaType("text/html")).toBeUndefined();
    // `application/json` is intentionally not an RDF type (it must not be
    // auto-parsed as a graph on write).
    expect(formatForMediaType("application/json")).toBeUndefined();
    // A missing Content-Type header passed straight through must not throw.
    expect(formatForMediaType(undefined as unknown as string)).toBeUndefined();
  });

  it("parses and serializes via media type", async () => {
    const quads = await parse(
      "<https://example.com/a> <https://example.com/b> <https://example.com/c> .",
      "text/turtle",
    );
    const jsonld = await serialize(quads, "application/ld+json");
    const reparsed = await parse(jsonld, "application/ld+json");
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]?.object.value).toBe("https://example.com/c");
  });

  it("rejects unsupported media types", async () => {
    await expect(parse("<a> <b> <c> .", "text/html")).rejects.toThrow(
      /unsupported media type/,
    );
  });

  it("crosses formats: Turtle in, N-Quads out, JSON-LD round-trip", async () => {
    const ttl = '@prefix ex: <https://example.com/> . ex:a ex:b "hi"@en , 42 .';
    const quads = await parse(ttl, "text/turtle");
    const nquads = await serialize(quads, "application/n-quads");
    const back = await parse(nquads, "application/n-quads");
    expect(back).toHaveLength(2);

    const jsonld = await serialize(quads, "application/ld+json");
    const viaJson = await parse(jsonld, "application/ld+json");
    expect(canonical(viaJson)).toEqual(canonical(quads));
  });
});
