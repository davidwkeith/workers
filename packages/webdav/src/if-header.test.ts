import { describe, expect, it } from "vitest";
import { parseIfHeader } from "./if-header.js";

describe("parseIfHeader", () => {
  it("returns none for absent or empty headers", () => {
    expect(parseIfHeader(null).kind).toBe("none");
    expect(parseIfHeader(undefined).kind).toBe("none");
    expect(parseIfHeader("   ").kind).toBe("none");
  });

  it("parses a single lock token", () => {
    const result = parseIfHeader("(<urn:uuid:abc-123>)");
    expect(result).toEqual({
      kind: "supported",
      condition: { lockToken: "urn:uuid:abc-123" },
    });
  });

  it("parses a single ETag, preserving quotes", () => {
    const result = parseIfHeader(`(["v1-etag"])`);
    expect(result).toEqual({
      kind: "supported",
      condition: { etag: `"v1-etag"` },
    });
  });

  it("parses a lock token and ETag together", () => {
    const result = parseIfHeader(`(<opaquelocktoken:tok> ["etag"])`);
    expect(result).toEqual({
      kind: "supported",
      condition: { lockToken: "opaquelocktoken:tok", etag: `"etag"` },
    });
  });

  it("strips a weak-validator prefix", () => {
    const result = parseIfHeader(`([W/"weak"])`);
    expect(result).toEqual({
      kind: "supported",
      condition: { etag: `"weak"` },
    });
  });

  it("rejects a tagged list", () => {
    expect(parseIfHeader("<http://x/r> (<urn:uuid:t>)").kind).toBe(
      "unsupported",
    );
  });

  it("rejects multiple groups", () => {
    expect(parseIfHeader("(<urn:uuid:a>) (<urn:uuid:b>)").kind).toBe(
      "unsupported",
    );
  });

  it("rejects the Not keyword", () => {
    expect(parseIfHeader("(Not <urn:uuid:t>)").kind).toBe("unsupported");
  });

  it("rejects two lock tokens in one list", () => {
    expect(parseIfHeader("(<urn:uuid:a> <urn:uuid:b>)").kind).toBe(
      "unsupported",
    );
  });

  it("rejects an empty list", () => {
    expect(parseIfHeader("()").kind).toBe("unsupported");
  });

  it("rejects an unterminated token", () => {
    expect(parseIfHeader("(<urn:uuid:a)").kind).toBe("unsupported");
  });
});
