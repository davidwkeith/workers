import { describe, expect, it } from "vitest";

import { negotiateMediaType } from "./negotiation";

describe("@dwk/solid-pod content negotiation", () => {
  it("defaults to Turtle when no Accept is given", () => {
    expect(negotiateMediaType(null)).toEqual({
      mediaType: "text/turtle",
      format: "Turtle",
    });
    expect(negotiateMediaType("")).toMatchObject({ format: "Turtle" });
    expect(negotiateMediaType("*/*")).toMatchObject({ format: "Turtle" });
  });

  it("honors explicit RDF media types", () => {
    expect(negotiateMediaType("application/ld+json")).toEqual({
      mediaType: "application/ld+json",
      format: "JSON-LD",
    });
    expect(negotiateMediaType("application/n-triples")).toMatchObject({
      format: "N-Triples",
    });
  });

  it("normalizes application/json to JSON-LD", () => {
    expect(negotiateMediaType("application/json")).toEqual({
      mediaType: "application/ld+json",
      format: "JSON-LD",
    });
  });

  it("respects q-values to pick the preferred type", () => {
    expect(
      negotiateMediaType("text/turtle;q=0.5, application/ld+json;q=0.9"),
    ).toMatchObject({ format: "JSON-LD" });
  });

  it("resolves a subtype wildcard within a family", () => {
    expect(negotiateMediaType("application/*")).toMatchObject({
      format: "JSON-LD",
    });
  });

  it("returns null (→ 406) when nothing in Accept is acceptable", () => {
    expect(negotiateMediaType("text/html")).toBeNull();
    expect(negotiateMediaType("application/pdf")).toBeNull();
    expect(negotiateMediaType("image/*")).toBeNull();
  });

  it("honors */* even alongside unsupported concrete types", () => {
    expect(negotiateMediaType("application/pdf, */*;q=0.1")).toMatchObject({
      format: "Turtle",
    });
  });
});
