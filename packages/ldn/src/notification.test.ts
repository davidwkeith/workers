import { describe, expect, it } from "vitest";

import {
  NotificationProblem,
  acceptPostHeader,
  acceptedContentTypes,
  parseNotification,
} from "./notification";

const TURTLE =
  "<https://sender.example/a> " +
  '<https://www.w3.org/ns/activitystreams#summary> "hi" .';

const JSONLD = JSON.stringify({
  "@id": "https://sender.example/a",
  "https://www.w3.org/ns/activitystreams#summary": "hi",
});

describe("parseNotification", () => {
  it("parses a Turtle notification into stored quads", async () => {
    const result = await parseNotification(TURTLE, "text/turtle");
    expect(result.format).toBe("Turtle");
    expect(result.mediaType).toBe("text/turtle");
    expect(result.quads).toHaveLength(1);
    expect(result.quads[0]?.subject.value).toBe("https://sender.example/a");
  });

  it("parses a JSON-LD notification", async () => {
    const result = await parseNotification(JSONLD, "application/ld+json");
    expect(result.format).toBe("JSON-LD");
    expect(result.quads).toHaveLength(1);
  });

  it("tolerates content-type parameters and casing", async () => {
    const result = await parseNotification(
      TURTLE,
      "Text/Turtle; charset=utf-8",
    );
    expect(result.format).toBe("Turtle");
    expect(result.mediaType).toBe("text/turtle");
  });

  it("resolves relative IRIs against baseIRI", async () => {
    const result = await parseNotification(
      "<> <http://example/p> <#it> .",
      "text/turtle",
      { baseIRI: "https://sender.example/note" },
    );
    expect(result.quads[0]?.subject.value).toBe("https://sender.example/note");
    expect(result.quads[0]?.object.value).toBe(
      "https://sender.example/note#it",
    );
  });

  it("rejects a missing Content-Type as 415", async () => {
    await expect(parseNotification(TURTLE, null)).rejects.toMatchObject({
      code: "unsupported_media_type",
      status: 415,
    });
  });

  it("rejects a non-RDF media type as 415", async () => {
    const error = await parseNotification(TURTLE, "text/plain").catch((e) => e);
    expect(error).toBeInstanceOf(NotificationProblem);
    expect(error.status).toBe(415);
  });

  it("rejects a malformed RDF body as 400", async () => {
    await expect(
      parseNotification("this is not turtle <<<", "text/turtle"),
    ).rejects.toMatchObject({ code: "malformed", status: 400 });
  });

  it("accepts a well-formed Turtle body that yields zero triples", async () => {
    // LDN §3.2 does not require a notification to carry at least one triple.
    const result = await parseNotification(
      "@prefix ex: <https://ex.example/> .",
      "text/turtle",
    );
    expect(result.format).toBe("Turtle");
    expect(result.quads).toEqual([]);
  });

  it("accepts a JSON-LD body with an empty @graph", async () => {
    const result = await parseNotification(
      JSON.stringify({ "@context": {}, "@graph": [] }),
      "application/ld+json",
    );
    expect(result.format).toBe("JSON-LD");
    expect(result.quads).toEqual([]);
  });

  it("exposes NotificationProblem as a named Error subclass", () => {
    const problem = new NotificationProblem("malformed", "boom");
    expect(problem).toBeInstanceOf(Error);
    expect(problem.name).toBe("NotificationProblem");
    expect(problem.message).toBe("boom");
  });
});

describe("acceptedContentTypes / acceptPostHeader", () => {
  it("lists the RDF media types parseNotification accepts", () => {
    const types = acceptedContentTypes();
    expect(types).toContain("application/ld+json");
    expect(types).toContain("text/turtle");
  });

  it("derives from the same table parseNotification validates against", async () => {
    // Each advertised type must round-trip through parseNotification, so the
    // advertisement and the validator cannot drift. An empty Turtle-family body
    // is a valid zero-triple document; JSON-LD needs a parseable JSON literal.
    for (const type of acceptedContentTypes()) {
      const body = type === "application/ld+json" ? "[]" : "";
      const result = await parseNotification(body, type);
      expect(result.mediaType).toBe(type);
    }
  });

  it("builds a comma-separated Accept-Post header from those types", () => {
    expect(acceptPostHeader()).toBe(acceptedContentTypes().join(", "));
    expect(acceptPostHeader()).toContain("application/ld+json");
  });
});
