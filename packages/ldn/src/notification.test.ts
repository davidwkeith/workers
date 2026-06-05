import { describe, expect, it } from "vitest";

import { NotificationProblem, parseNotification } from "./notification";

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

  it("rejects an RDF body with no triples as 400", async () => {
    await expect(
      parseNotification("@prefix ex: <https://ex.example/> .", "text/turtle"),
    ).rejects.toMatchObject({ code: "malformed", status: 400 });
  });

  it("exposes NotificationProblem as a named Error subclass", () => {
    const problem = new NotificationProblem("malformed", "boom");
    expect(problem).toBeInstanceOf(Error);
    expect(problem.name).toBe("NotificationProblem");
    expect(problem.message).toBe("boom");
  });
});
