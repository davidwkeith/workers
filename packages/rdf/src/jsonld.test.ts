import { describe, expect, it } from "vitest";

import { JsonLdError, parseJsonLd, writeJsonLd } from "./jsonld";
import type { Quad } from "n3";

/** Order-independent canonical form for comparing quad sets. */
function canonical(quads: Quad[]): string[] {
  return quads
    .map((q) => {
      const o = q.object;
      const lang = o.termType === "Literal" ? o.language : "";
      const dt = o.termType === "Literal" ? o.datatype.value : "";
      const s = q.subject.termType === "BlankNode" ? "_:b" : q.subject.value;
      const obj = o.termType === "BlankNode" ? "_:b" : o.value;
      return `${s} ${q.predicate.value} ${obj} ${lang} ${dt} ${q.graph.value}`;
    })
    .sort();
}

/** parse → serialize → parse must preserve the quad set. */
async function expectRoundTrip(doc: unknown): Promise<Quad[]> {
  const quads = await parseJsonLd(doc as never);
  const serialized = await writeJsonLd(quads);
  const reparsed = await parseJsonLd(serialized);
  expect(canonical(reparsed)).toEqual(canonical(quads));
  return quads;
}

describe("@dwk/rdf JSON-LD parse", () => {
  it("expands compact IRIs via a prefix context", async () => {
    const quads = await parseJsonLd({
      "@context": { ex: "https://example.com/" },
      "@id": "ex:a",
      "ex:knows": { "@id": "ex:b" },
    });
    expect(quads).toHaveLength(1);
    expect(quads[0]?.subject.value).toBe("https://example.com/a");
    expect(quads[0]?.predicate.value).toBe("https://example.com/knows");
    expect(quads[0]?.object.value).toBe("https://example.com/b");
  });

  it("applies @vocab and term definitions", async () => {
    const quads = await parseJsonLd({
      "@context": {
        "@vocab": "https://schema.org/",
        homepage: { "@id": "https://schema.org/url", "@type": "@id" },
      },
      "@id": "https://example.com/me",
      "@type": "Person",
      name: "Ada",
      homepage: "https://example.com/",
    });

    const type = quads.find((q) => q.predicate.value.endsWith("#type"));
    expect(type?.object.value).toBe("https://schema.org/Person");

    const name = quads.find(
      (q) => q.predicate.value === "https://schema.org/name",
    );
    expect(name?.object.termType).toBe("Literal");
    expect(name?.object.value).toBe("Ada");

    const home = quads.find(
      (q) => q.predicate.value === "https://schema.org/url",
    );
    expect(home?.object.termType).toBe("NamedNode");
    expect(home?.object.value).toBe("https://example.com/");
  });

  it("types native literals (string, integer, double, boolean, language)", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/", "@language": "en" },
      "@id": "https://ex/s",
      str: "plain",
      count: 42,
      ratio: 1.5,
      flag: true,
      typed: { "@value": "2024-01-01", "@type": "https://ex/Date" },
    });
    const byPred = (p: string) =>
      quads.find((q) => q.predicate.value === `https://ex/${p}`)?.object;

    expect(byPred("str")?.value).toBe("plain");
    expect((byPred("str") as { language: string }).language).toBe("en");
    expect(
      (byPred("count") as { datatype: { value: string } }).datatype.value,
    ).toBe("http://www.w3.org/2001/XMLSchema#integer");
    expect(
      (byPred("ratio") as { datatype: { value: string } }).datatype.value,
    ).toBe("http://www.w3.org/2001/XMLSchema#double");
    expect(
      (byPred("flag") as { datatype: { value: string } }).datatype.value,
    ).toBe("http://www.w3.org/2001/XMLSchema#boolean");
    expect(
      (byPred("typed") as { datatype: { value: string } }).datatype.value,
    ).toBe("https://ex/Date");
  });

  it("turns @list into an rdf:first/rdf:rest chain terminated by rdf:nil", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/", items: { "@container": "@list" } },
      "@id": "https://ex/s",
      items: ["a", "b"],
    });
    const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
    expect(
      quads.filter((q) => q.predicate.value === `${RDF}first`),
    ).toHaveLength(2);
    expect(quads.some((q) => q.object.value === `${RDF}nil`)).toBe(true);
  });

  it("handles a named graph", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/g",
      "@graph": [{ "@id": "https://ex/s", p: { "@id": "https://ex/o" } }],
    });
    expect(quads[0]?.graph.value).toBe("https://ex/g");
    expect(quads[0]?.subject.value).toBe("https://ex/s");
  });

  it("processes a top-level @graph as the default graph", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@graph": [
        { "@id": "https://ex/a", p: { "@id": "https://ex/b" } },
        { "@id": "https://ex/c", p: { "@id": "https://ex/d" } },
      ],
    });
    expect(quads).toHaveLength(2);
    expect(quads.every((q) => q.graph.termType === "DefaultGraph")).toBe(true);
  });

  it("rejects remote contexts and invalid JSON", async () => {
    await expect(
      parseJsonLd({ "@context": "https://schema.org", "@id": "https://ex/a" }),
    ).rejects.toBeInstanceOf(JsonLdError);
    await expect(parseJsonLd("{not json")).rejects.toBeInstanceOf(JsonLdError);
  });
});

describe("@dwk/rdf JSON-LD round-trips", () => {
  it("round-trips IRIs, typed and language literals", async () => {
    await expectRoundTrip({
      "@context": { ex: "https://example.com/", "@language": "en" },
      "@id": "ex:a",
      "ex:label": "hello",
      "ex:ref": { "@id": "ex:b" },
      "ex:age": { "@value": "30", "@type": "https://example.com/Int" },
    });
  });

  it("round-trips blank nodes and nested node objects", async () => {
    await expectRoundTrip({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      knows: { name: "anon", age: { "@value": "1", "@type": "https://ex/n" } },
    });
  });

  it("round-trips lists and named graphs", async () => {
    await expectRoundTrip({
      "@context": { "@vocab": "https://ex/", items: { "@container": "@list" } },
      "@id": "https://ex/g",
      "@graph": [{ "@id": "https://ex/s", items: ["x", "y", "z"] }],
    });
  });

  it("serializes plain strings without @type and language strings with @language", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      plain: "x",
      tagged: { "@value": "y", "@language": "fr" },
    });
    const out = JSON.parse(await writeJsonLd(quads)) as Array<
      Record<string, unknown>
    >;
    const node = out[0]!;
    expect(node["https://ex/plain"]).toEqual([{ "@value": "x" }]);
    expect(node["https://ex/tagged"]).toEqual([
      { "@value": "y", "@language": "fr" },
    ]);
  });
});
