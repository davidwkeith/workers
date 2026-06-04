import { describe, expect, it } from "vitest";
import { DataFactory } from "n3";

import { JsonLdError, parseJsonLd, writeJsonLd } from "./jsonld";
import type { Quad } from "n3";

const { namedNode, blankNode, literal, quad, defaultGraph, variable } =
  DataFactory;
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;
const RDF_TYPE = `${RDF}type`;
const RDF_LIST = `${RDF}List`;

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

  it("drops reverse properties whose object would be a literal subject", async () => {
    const quads = await parseJsonLd({
      "@context": {
        "@vocab": "https://ex/",
        parent: { "@reverse": "https://ex/child" },
      },
      "@id": "https://ex/p",
      parent: ["not-a-node", { "@id": "https://ex/c" }],
    });
    // Only the node reference yields a (valid) reversed quad.
    expect(quads).toHaveLength(1);
    expect(quads[0]?.subject.value).toBe("https://ex/c");
    expect(quads[0]?.object.value).toBe("https://ex/p");
  });

  it("drops literals inside an @reverse block", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/p",
      "@reverse": { child: ["nope", { "@id": "https://ex/c" }] },
    });
    expect(quads).toHaveLength(1);
    expect(quads[0]?.subject.value).toBe("https://ex/c");
  });

  it("disables a term mapped to null (dropped, not vocab-expanded)", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/", name: null },
      "@id": "https://ex/s",
      name: "dropped",
      age: { "@value": "5", "@type": "https://ex/n" },
    });
    expect(quads).toHaveLength(1);
    expect(quads[0]?.predicate.value).toBe("https://ex/age");
  });

  it("emits canonical xsd:double lexical forms for non-finite numbers", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      nan: Number.NaN,
      pos: Number.POSITIVE_INFINITY,
      neg: Number.NEGATIVE_INFINITY,
    });
    const lex = (p: string) =>
      quads.find((q) => q.predicate.value === `https://ex/${p}`)?.object.value;
    expect(lex("nan")).toBe("NaN");
    expect(lex("pos")).toBe("INF");
    expect(lex("neg")).toBe("-INF");
  });

  it("drops a node whose @id is a relative IRI with no base", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "relative-subject",
      name: "ignored",
    });
    expect(quads).toHaveLength(0);
  });

  it("drops a relative @id object reference but keeps valid triples", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/", ref: { "@type": "@id" } },
      "@id": "https://ex/s",
      ref: "relative", // unresolvable -> dropped
      name: "kept",
    });
    expect(quads).toHaveLength(1);
    expect(quads[0]?.predicate.value).toBe("https://ex/name");
  });

  it("resolves relative IRIs against an explicit base", async () => {
    const quads = await parseJsonLd(
      {
        "@context": { "@vocab": "https://ex/", ref: { "@type": "@id" } },
        "@id": "s",
        ref: "o",
      },
      { base: "https://base.example/dir/" },
    );
    expect(quads).toHaveLength(1);
    expect(quads[0]?.subject.value).toBe("https://base.example/dir/s");
    expect(quads[0]?.object.value).toBe("https://base.example/dir/o");
  });

  it("emits canonical xsd:double lexical forms for finite numbers", async () => {
    const XSD_DOUBLE = "http://www.w3.org/2001/XMLSchema#double";
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      a: 1.5,
      b: { "@value": 100, "@type": XSD_DOUBLE },
      c: { "@value": 1e-7, "@type": XSD_DOUBLE },
      d: 1e21,
      e: 42,
    });
    const obj = (p: string) =>
      quads.find((q) => q.predicate.value === `https://ex/${p}`)?.object;
    expect(obj("a")?.value).toBe("1.5E0");
    expect(obj("b")?.value).toBe("1.0E2");
    expect(obj("c")?.value).toBe("1.0E-7");
    // A magnitude >= 1e21 is an xsd:double, in canonical form (not "1e+21").
    expect(obj("d")?.value).toBe("1.0E21");
    expect((obj("d") as { datatype: { value: string } }).datatype.value).toBe(
      XSD_DOUBLE,
    );
    // Ordinary integers stay xsd:integer in canonical decimal form.
    expect(obj("e")?.value).toBe("42");
    expect((obj("e") as { datatype: { value: string } }).datatype.value).toBe(
      "http://www.w3.org/2001/XMLSchema#integer",
    );
  });

  it("keeps an explicit xsd:integer in integer lexical space (BigInt past 1e21)", async () => {
    const XSD_INTEGER = "http://www.w3.org/2001/XMLSchema#integer";
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      // A magnitude >= 1e21 explicitly typed xsd:integer must not be emitted in
      // exponential notation (which is outside xsd:integer's lexical space).
      big: { "@value": 1e21, "@type": XSD_INTEGER },
    });
    const object = quads[0]?.object;
    expect(object?.value).toBe("1000000000000000000000");
    expect((object as { datatype: { value: string } }).datatype.value).toBe(
      XSD_INTEGER,
    );
  });

  it("drops a value object whose @value is null", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      gone: { "@value": null },
      kept: { "@value": "x" },
    });
    expect(quads).toHaveLength(1);
    expect(quads[0]?.predicate.value).toBe("https://ex/kept");
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

  it("reconstructs @list on serialize, collapsing the cell chain", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/", items: { "@container": "@list" } },
      "@id": "https://ex/s",
      items: ["a", "b", "c"],
    });
    const out = JSON.parse(await writeJsonLd(quads)) as Array<
      Record<string, unknown>
    >;
    // Only the subject node survives; the rdf:first/rest cells are collapsed.
    expect(out).toHaveLength(1);
    expect(out[0]!["https://ex/items"]).toEqual([
      { "@list": [{ "@value": "a" }, { "@value": "b" }, { "@value": "c" }] },
    ]);
  });

  it("serializes an empty @list as an rdf:nil reference", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/", items: { "@container": "@list" } },
      "@id": "https://ex/s",
      items: [],
    });
    const out = JSON.parse(await writeJsonLd(quads)) as Array<
      Record<string, unknown>
    >;
    expect(out[0]!["https://ex/items"]).toEqual([
      { "@id": "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil" },
    ]);
  });

  it("round-trips a list of node references", async () => {
    await expectRoundTrip({
      "@context": { "@vocab": "https://ex/", items: { "@container": "@list" } },
      "@id": "https://ex/s",
      items: [{ "@id": "https://ex/a" }, { "@id": "https://ex/b" }],
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

describe("@dwk/rdf JSON-LD context edge cases", () => {
  it("rejects a term definition that is neither string, object, nor null", async () => {
    await expect(
      parseJsonLd({ "@context": { bad: 42 }, "@id": "https://ex/s" }),
    ).rejects.toBeInstanceOf(JsonLdError);
  });

  it("rejects a non-object, non-string @context entry", async () => {
    await expect(
      parseJsonLd({ "@context": [42], "@id": "https://ex/s" }),
    ).rejects.toBeInstanceOf(JsonLdError);
  });

  it("honours @base, @vocab, @language, and ignores @version", async () => {
    const quads = await parseJsonLd({
      "@context": {
        "@version": 1.1,
        "@base": "https://base.example/dir/",
        "@vocab": "https://ex/",
        "@language": "en",
      },
      "@id": "rel",
      name: "hi",
    });
    expect(quads).toHaveLength(1);
    expect(quads[0]?.subject.value).toBe("https://base.example/dir/rel");
    expect(quads[0]?.predicate.value).toBe("https://ex/name");
    expect((quads[0]?.object as { language: string }).language).toBe("en");
  });

  it("clears @base/@vocab/@language when re-set to null in a later context", async () => {
    const quads = await parseJsonLd({
      "@context": [
        {
          "@base": "https://base.example/",
          "@vocab": "https://ex/",
          "@language": "en",
        },
        { "@base": null, "@vocab": null, "@language": null },
      ],
      // With @vocab and @base cleared, a bare term and relative @id both drop.
      "@id": "https://ex/s",
      "https://ex/name": "kept",
      dropped: "x",
    });
    expect(quads).toHaveLength(1);
    expect(quads[0]?.predicate.value).toBe("https://ex/name");
    expect((quads[0]?.object as { language: string }).language).toBe("");
  });

  it("resets the active context on a null entry mid-array", async () => {
    const quads = await parseJsonLd({
      "@context": [
        { "@vocab": "https://gone/", old: "https://gone/old" },
        null,
        { fresh: "https://ex/fresh" },
      ],
      "@id": "https://ex/s",
      fresh: { "@id": "https://ex/o" },
      old: "ignored", // term cleared by the null reset
    });
    expect(quads).toHaveLength(1);
    expect(quads[0]?.predicate.value).toBe("https://ex/fresh");
  });

  it("supports @reverse, @id:null, @type:@vocab, @language and @container array term defs", async () => {
    const quads = await parseJsonLd({
      "@context": {
        "@vocab": "https://ex/",
        rev: { "@reverse": "https://ex/back" },
        disabled: { "@id": null },
        voc: { "@id": "https://ex/voc", "@type": "@vocab" },
        lang: { "@id": "https://ex/lang", "@language": "fr" },
        listy: { "@container": ["@list"] },
      },
      "@id": "https://ex/s",
      rev: { "@id": "https://ex/o" },
      disabled: "dropped",
      voc: "Thing",
      lang: "bonjour",
      listy: ["a", "b"],
    });

    // @reverse term: object becomes the subject of the back-edge.
    const back = quads.find((q) => q.predicate.value === "https://ex/back");
    expect(back?.subject.value).toBe("https://ex/o");
    expect(back?.object.value).toBe("https://ex/s");

    // @type:@vocab coerces the string through @vocab into an IRI node.
    const voc = quads.find((q) => q.predicate.value === "https://ex/voc");
    expect(voc?.object.termType).toBe("NamedNode");
    expect(voc?.object.value).toBe("https://ex/Thing");

    // term-level @language wins.
    const lang = quads.find((q) => q.predicate.value === "https://ex/lang");
    expect((lang?.object as { language: string }).language).toBe("fr");

    // @container:["@list"] builds an rdf:first/rest chain.
    expect(quads.filter((q) => q.predicate.value === RDF_FIRST)).toHaveLength(
      2,
    );

    // the disabled term emitted nothing.
    expect(quads.some((q) => q.predicate.value === "https://ex/disabled")).toBe(
      false,
    );
  });

  it("drops a bare term when no @vocab is in scope", async () => {
    const quads = await parseJsonLd({
      "@context": { ex: "https://ex/" },
      "@id": "https://ex/s",
      bareword: "x", // no prefix, no @vocab -> unresolvable -> dropped
    });
    expect(quads).toHaveLength(0);
  });

  it("drops a relative @id when the base IRI is itself invalid", async () => {
    const quads = await parseJsonLd(
      {
        "@context": { "@vocab": "https://ex/" },
        "@id": "rel",
        name: "x",
      },
      { base: "::::not-a-valid-base" },
    );
    expect(quads).toHaveLength(0);
  });
});

describe("@dwk/rdf JSON-LD expansion edge cases", () => {
  it("skips non-object items in a top-level array", async () => {
    const quads = await parseJsonLd([
      "ignored",
      42,
      {
        "@context": { "@vocab": "https://ex/" },
        "@id": "https://ex/s",
        name: "ok",
      },
    ] as never);
    expect(quads).toHaveLength(1);
    expect(quads[0]?.predicate.value).toBe("https://ex/name");
  });

  it("skips keyword @type values and unsupported keyword keys", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      "@type": "@json", // keyword type -> not emitted as a triple
      "@index": "anything", // unsupported keyword key -> skipped
      name: "kept",
    });
    expect(quads).toHaveLength(1);
    expect(quads[0]?.predicate.value).toBe("https://ex/name");
  });

  it("skips @reverse entries whose key expands to a keyword", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      "@reverse": {
        "@bogus": { "@id": "https://ex/o" }, // keyword key -> skipped
        child: { "@id": "https://ex/c" },
      },
    });
    expect(quads).toHaveLength(1);
    expect(quads[0]?.subject.value).toBe("https://ex/c");
    expect(quads[0]?.predicate.value).toBe("https://ex/child");
  });

  it("drops null and nested-array values within a property", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      vals: [null, ["nested"], "keep"], // null + nested array drop, string kept
    });
    expect(quads).toHaveLength(1);
    expect(quads[0]?.object.value).toBe("keep");
  });

  it("treats a CURIE with an undefined prefix as an absolute IRI", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      "unknownpfx:term": "x", // no prefix def -> kept verbatim as an IRI
    });
    expect(quads).toHaveLength(1);
    expect(quads[0]?.predicate.value).toBe("unknownpfx:term");
  });

  it("builds a nested @list inside an outer @list", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/", outer: { "@container": "@list" } },
      "@id": "https://ex/s",
      outer: [{ "@list": ["a"] }],
    });
    // Two cells: the outer cell and the inner one-element list cell.
    expect(quads.filter((q) => q.predicate.value === RDF_FIRST)).toHaveLength(
      2,
    );
    expect(quads.filter((q) => q.object.value === RDF_NIL)).toHaveLength(2);
  });

  it("builds a list from an inline @list value object (no container)", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      items: { "@list": ["a", "b"] },
    });
    expect(quads.filter((q) => q.predicate.value === RDF_FIRST)).toHaveLength(
      2,
    );
    expect(quads.some((q) => q.object.value === RDF_NIL)).toBe(true);
  });

  it("applies an IRI datatype term to string, number, and boolean literals", async () => {
    const quads = await parseJsonLd({
      "@context": {
        "@vocab": "https://ex/",
        s: { "@type": "https://ex/Str" },
        n: { "@type": "https://ex/Num" },
        b: { "@type": "https://ex/Bool" },
      },
      "@id": "https://ex/x",
      s: "text",
      n: 5,
      b: true,
    });
    const dt = (p: string) =>
      (
        quads.find((q) => q.predicate.value === `https://ex/${p}`)?.object as {
          datatype: { value: string };
        }
      ).datatype.value;
    expect(dt("s")).toBe("https://ex/Str");
    expect(dt("n")).toBe("https://ex/Num");
    expect(dt("b")).toBe("https://ex/Bool");
  });

  it("ignores @id/@vocab type coercion on native number values", async () => {
    const quads = await parseJsonLd({
      "@context": {
        "@vocab": "https://ex/",
        byId: { "@type": "@id" },
        byVocab: { "@type": "@vocab" },
      },
      "@id": "https://ex/s",
      byId: 7, // a number can't be an @id; falls back to a typed literal
      byVocab: 8,
    });
    const obj = (p: string) =>
      quads.find((q) => q.predicate.value === `https://ex/${p}`)?.object;
    expect(obj("byId")?.termType).toBe("Literal");
    expect(
      (obj("byId") as { datatype: { value: string } }).datatype.value,
    ).toBe("http://www.w3.org/2001/XMLSchema#integer");
    expect(obj("byVocab")?.termType).toBe("Literal");
  });
});

describe("@dwk/rdf JSON-LD value object edge cases", () => {
  it("types boolean @value objects and round-trips true/false", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      yes: { "@value": true },
      no: { "@value": false },
    });
    const obj = (p: string) =>
      quads.find((q) => q.predicate.value === `https://ex/${p}`)?.object;
    expect(obj("yes")?.value).toBe("true");
    expect(obj("no")?.value).toBe("false");
    expect((obj("yes") as { datatype: { value: string } }).datatype.value).toBe(
      "http://www.w3.org/2001/XMLSchema#boolean",
    );
  });

  it("types untyped numeric @value objects as integer or double", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      whole: { "@value": 7 },
      frac: { "@value": 7.5 },
    });
    const obj = (p: string) =>
      quads.find((q) => q.predicate.value === `https://ex/${p}`)?.object;
    expect(
      (obj("whole") as { datatype: { value: string } }).datatype.value,
    ).toBe("http://www.w3.org/2001/XMLSchema#integer");
    expect(obj("whole")?.value).toBe("7");
    expect(
      (obj("frac") as { datatype: { value: string } }).datatype.value,
    ).toBe("http://www.w3.org/2001/XMLSchema#double");
    expect(obj("frac")?.value).toBe("7.5E0");
  });

  it("renders an integer @value with a custom datatype past 1e21 in integer space", async () => {
    const quads = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      // custom (non-xsd:integer, non-xsd:double) datatype with a huge integer:
      // exercises the magnitude>=1e21 branch under an explicit type.
      big: { "@value": 1e21, "@type": "https://ex/Big" },
    });
    const object = quads[0]?.object;
    expect((object as { datatype: { value: string } }).datatype.value).toBe(
      "https://ex/Big",
    );
    expect(object?.value).toBe("1.0E21");
  });

  it("tags a plain string @value with the active @language, else leaves it plain", async () => {
    const tagged = await parseJsonLd({
      "@context": { "@vocab": "https://ex/", "@language": "de" },
      "@id": "https://ex/s",
      greet: { "@value": "hallo" },
    });
    expect((tagged[0]?.object as { language: string }).language).toBe("de");

    const plain = await parseJsonLd({
      "@context": { "@vocab": "https://ex/" },
      "@id": "https://ex/s",
      greet: { "@value": "hello" },
    });
    expect((plain[0]?.object as { language: string }).language).toBe("");
    expect(
      (plain[0]?.object as { datatype: { value: string } }).datatype.value,
    ).toBe("http://www.w3.org/2001/XMLSchema#string");
  });
});

describe("@dwk/rdf JSON-LD serialization edge cases", () => {
  const dg = defaultGraph();

  it("serializes rdf:type with a NamedNode object as @type", async () => {
    const out = JSON.parse(
      await writeJsonLd([
        quad(
          namedNode("https://ex/s"),
          namedNode(RDF_TYPE),
          namedNode("https://ex/Type"),
          dg,
        ),
      ]),
    ) as Array<Record<string, unknown>>;
    expect(out[0]!["@type"]).toEqual(["https://ex/Type"]);
  });

  it("serializes an unusual term type (Variable) via its bare value", async () => {
    const out = JSON.parse(
      await writeJsonLd([
        quad(
          namedNode("https://ex/s"),
          namedNode("https://ex/p"),
          variable("v") as never,
          dg,
        ),
      ]),
    ) as Array<Record<string, unknown>>;
    expect(out[0]!["https://ex/p"]).toEqual([{ "@id": "v" }]);
  });

  it("collapses a list cell carrying an explicit @type rdf:List", async () => {
    const out = JSON.parse(
      await writeJsonLd([
        quad(
          namedNode("https://ex/s"),
          namedNode("https://ex/items"),
          blankNode("l0"),
          dg,
        ),
        quad(blankNode("l0"), namedNode(RDF_FIRST), literal("a"), dg),
        quad(blankNode("l0"), namedNode(RDF_REST), namedNode(RDF_NIL), dg),
        quad(blankNode("l0"), namedNode(RDF_TYPE), namedNode(RDF_LIST), dg),
      ]),
    ) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect(out[0]!["https://ex/items"]).toEqual([
      { "@list": [{ "@value": "a" }] },
    ]);
  });

  it("does not collapse a cell that carries an extra property", async () => {
    const out = JSON.parse(
      await writeJsonLd([
        quad(
          namedNode("https://ex/s"),
          namedNode("https://ex/items"),
          blankNode("l0"),
          dg,
        ),
        quad(blankNode("l0"), namedNode(RDF_FIRST), literal("a"), dg),
        quad(blankNode("l0"), namedNode(RDF_REST), namedNode(RDF_NIL), dg),
        quad(blankNode("l0"), namedNode("https://ex/extra"), literal("x"), dg),
      ]),
    ) as Array<Record<string, unknown>>;
    // The cell stays a node reference; no @list reconstruction.
    const flat = JSON.stringify(out);
    expect(flat).not.toContain("@list");
  });

  it("does not collapse a cell with a non-rdf:List @type", async () => {
    const out = JSON.parse(
      await writeJsonLd([
        quad(
          namedNode("https://ex/s"),
          namedNode("https://ex/items"),
          blankNode("l0"),
          dg,
        ),
        quad(blankNode("l0"), namedNode(RDF_FIRST), literal("a"), dg),
        quad(blankNode("l0"), namedNode(RDF_REST), namedNode(RDF_NIL), dg),
        quad(
          blankNode("l0"),
          namedNode(RDF_TYPE),
          namedNode("https://ex/Other"),
          dg,
        ),
      ]),
    ) as Array<Record<string, unknown>>;
    expect(JSON.stringify(out)).not.toContain("@list");
  });

  it("does not collapse a cell with duplicate rdf:first", async () => {
    const out = JSON.parse(
      await writeJsonLd([
        quad(
          namedNode("https://ex/s"),
          namedNode("https://ex/items"),
          blankNode("l0"),
          dg,
        ),
        quad(blankNode("l0"), namedNode(RDF_FIRST), literal("a"), dg),
        quad(blankNode("l0"), namedNode(RDF_FIRST), literal("b"), dg),
        quad(blankNode("l0"), namedNode(RDF_REST), namedNode(RDF_NIL), dg),
      ]),
    ) as Array<Record<string, unknown>>;
    expect(JSON.stringify(out)).not.toContain("@list");
  });

  it("does not collapse a cell with duplicate rdf:rest", async () => {
    const out = JSON.parse(
      await writeJsonLd([
        quad(
          namedNode("https://ex/s"),
          namedNode("https://ex/items"),
          blankNode("l0"),
          dg,
        ),
        quad(blankNode("l0"), namedNode(RDF_FIRST), literal("a"), dg),
        quad(blankNode("l0"), namedNode(RDF_REST), namedNode(RDF_NIL), dg),
        quad(blankNode("l0"), namedNode(RDF_REST), blankNode("l1"), dg),
      ]),
    ) as Array<Record<string, unknown>>;
    expect(JSON.stringify(out)).not.toContain("@list");
  });

  it("does not collapse an rdf:rest/rdf:nil chain rooted at a named node", async () => {
    const out = JSON.parse(
      await writeJsonLd([
        quad(namedNode("https://ex/n"), namedNode(RDF_FIRST), literal("a"), dg),
        quad(
          namedNode("https://ex/n"),
          namedNode(RDF_REST),
          namedNode(RDF_NIL),
          dg,
        ),
      ]),
    ) as Array<Record<string, unknown>>;
    expect(JSON.stringify(out)).not.toContain("@list");
  });

  it("does not collapse a list cell that is referenced more than once", async () => {
    const out = JSON.parse(
      await writeJsonLd([
        quad(
          namedNode("https://ex/s1"),
          namedNode("https://ex/items"),
          blankNode("l0"),
          dg,
        ),
        quad(
          namedNode("https://ex/s2"),
          namedNode("https://ex/items"),
          blankNode("l0"),
          dg,
        ),
        quad(blankNode("l0"), namedNode(RDF_FIRST), literal("a"), dg),
        quad(blankNode("l0"), namedNode(RDF_REST), namedNode(RDF_NIL), dg),
      ]),
    ) as Array<Record<string, unknown>>;
    expect(JSON.stringify(out)).not.toContain("@list");
  });
});
