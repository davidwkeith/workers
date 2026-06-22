import { describe, expect, it } from "vitest";
import { inferContentType } from "./content-type.js";

describe("inferContentType", () => {
  it("lets a specific client Content-Type win", () => {
    expect(inferContentType("note.ttl", "application/ld+json")).toBe(
      "application/ld+json",
    );
    expect(inferContentType("photo.bin", "image/png")).toBe("image/png");
  });

  it("strips parameters from a specific declared type", () => {
    expect(inferContentType("x", "text/turtle; charset=utf-8")).toBe(
      "text/turtle",
    );
  });

  it("infers from extension when the type is generic", () => {
    expect(inferContentType("note.ttl", "application/octet-stream")).toBe(
      "text/turtle",
    );
    expect(inferContentType("data.jsonld", "text/plain")).toBe(
      "application/ld+json",
    );
  });

  it("infers from extension when no type is declared", () => {
    expect(inferContentType("photo.jpg")).toBe("image/jpeg");
    expect(inferContentType("/pod/path/to/event.ics", null)).toBe(
      "text/calendar",
    );
  });

  it("falls back to octet-stream for unknown extensions with no usable type", () => {
    expect(inferContentType("mystery.xyz")).toBe("application/octet-stream");
    expect(inferContentType("noext", "application/octet-stream")).toBe(
      "application/octet-stream",
    );
  });

  it("keeps a generic declared type when extension is unknown", () => {
    expect(inferContentType("mystery.xyz", "text/plain")).toBe("text/plain");
  });

  it("ignores a trailing dot", () => {
    expect(inferContentType("weird.")).toBe("application/octet-stream");
  });
});
