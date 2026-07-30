import { describe, expect, it } from "vitest";
import { parseIfHeader, submittedLockTokens } from "./if-header.js";

describe("parseIfHeader", () => {
  it("returns none for absent or empty headers", () => {
    expect(parseIfHeader(null).kind).toBe("none");
    expect(parseIfHeader(undefined).kind).toBe("none");
    expect(parseIfHeader("   ").kind).toBe("none");
  });

  it("parses a single lock token", () => {
    const result = parseIfHeader("(<urn:uuid:abc-123>)");
    expect(result).toEqual({
      kind: "lists",
      lists: [{ conditions: [{ not: false, lockToken: "urn:uuid:abc-123" }] }],
    });
  });

  it("parses a single ETag, preserving quotes", () => {
    const result = parseIfHeader(`(["v1-etag"])`);
    expect(result).toEqual({
      kind: "lists",
      lists: [{ conditions: [{ not: false, etag: `"v1-etag"` }] }],
    });
  });

  it("parses a lock token and ETag together", () => {
    const result = parseIfHeader(`(<opaquelocktoken:tok> ["etag"])`);
    expect(result).toEqual({
      kind: "lists",
      lists: [
        {
          conditions: [
            { not: false, lockToken: "opaquelocktoken:tok" },
            { not: false, etag: `"etag"` },
          ],
        },
      ],
    });
  });

  it("strips a weak-validator prefix", () => {
    const result = parseIfHeader(`([W/"weak"])`);
    expect(result).toEqual({
      kind: "lists",
      lists: [{ conditions: [{ not: false, etag: `"weak"` }] }],
    });
  });

  // neon-based clients (litmus `owner_modify`, davfs2) always tag the list
  // with the locked resource's URI; refusing the tag 400s the lock owner's
  // own keyed writes.
  it("parses a tagged list", () => {
    const result = parseIfHeader("<http://x/r> (<urn:uuid:t>)");
    expect(result).toEqual({
      kind: "lists",
      lists: [
        {
          resourceTag: "http://x/r",
          conditions: [{ not: false, lockToken: "urn:uuid:t" }],
        },
      ],
    });
  });

  it("parses multiple tagged lists, each scoped to its own tag", () => {
    const result = parseIfHeader(
      "<http://x/r> (<urn:uuid:t>) <http://x/s> (<urn:uuid:u>)",
    );
    expect(result).toEqual({
      kind: "lists",
      lists: [
        {
          resourceTag: "http://x/r",
          conditions: [{ not: false, lockToken: "urn:uuid:t" }],
        },
        {
          resourceTag: "http://x/s",
          conditions: [{ not: false, lockToken: "urn:uuid:u" }],
        },
      ],
    });
  });

  // litmus `cond_put_with_not` / `complex_cond_put`: multiple untagged lists
  // OR together, and `Not <DAV:no-lock>` is the standard always-true arm.
  it("parses multiple untagged lists with Not", () => {
    const result = parseIfHeader(`(<urn:uuid:a>) (Not <DAV:no-lock> ["e"])`);
    expect(result).toEqual({
      kind: "lists",
      lists: [
        { conditions: [{ not: false, lockToken: "urn:uuid:a" }] },
        {
          conditions: [
            { not: true, lockToken: "DAV:no-lock" },
            { not: false, etag: `"e"` },
          ],
        },
      ],
    });
  });

  it("parses two lock tokens in one list", () => {
    const result = parseIfHeader("(<urn:uuid:a> <urn:uuid:b>)");
    expect(result).toEqual({
      kind: "lists",
      lists: [
        {
          conditions: [
            { not: false, lockToken: "urn:uuid:a" },
            { not: false, lockToken: "urn:uuid:b" },
          ],
        },
      ],
    });
  });

  it("rejects a bare Not with no condition", () => {
    expect(parseIfHeader("(Not)").kind).toBe("unsupported");
    expect(parseIfHeader("(<urn:uuid:a> Not)").kind).toBe("unsupported");
  });

  it("rejects a doubled Not", () => {
    expect(parseIfHeader("(Not Not <urn:uuid:a>)").kind).toBe("unsupported");
  });

  it("rejects an empty list", () => {
    expect(parseIfHeader("()").kind).toBe("unsupported");
  });

  it("rejects an unterminated token", () => {
    expect(parseIfHeader("(<urn:uuid:a)").kind).toBe("unsupported");
  });

  it("rejects a dangling resource tag", () => {
    expect(parseIfHeader("<http://x/r>").kind).toBe("unsupported");
    expect(parseIfHeader("(<urn:uuid:a>) <http://x/r>").kind).toBe(
      "unsupported",
    );
  });

  it("rejects more lists than the DoS bound", () => {
    expect(parseIfHeader("(<urn:uuid:a>)".repeat(9)).kind).toBe("unsupported");
  });
});

describe("submittedLockTokens", () => {
  it("collects positively-named tokens across lists", () => {
    const parsed = parseIfHeader(
      `(<urn:uuid:a> ["e"]) <http://x/r> (<urn:uuid:b>)`,
    );
    expect(submittedLockTokens(parsed)).toEqual(["urn:uuid:a", "urn:uuid:b"]);
  });

  // Naming a token only under `Not` is not a submission (litmus
  // `cond_put_corrupt_token`: `(Not <DAV:no-lock>)` must not admit a write
  // to a locked resource).
  it("excludes tokens named under Not", () => {
    const parsed = parseIfHeader("(Not <DAV:no-lock>)");
    expect(submittedLockTokens(parsed)).toEqual([]);
  });

  it("is empty for none/unsupported", () => {
    expect(submittedLockTokens(parseIfHeader(null))).toEqual([]);
    expect(submittedLockTokens(parseIfHeader("()"))).toEqual([]);
  });
});
