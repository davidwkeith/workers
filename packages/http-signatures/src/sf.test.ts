import { describe, expect, it } from "vitest";

import {
  parseSignatureHeader,
  parseSignatureInput,
  SfParseError,
  serializeString,
} from "./sf.js";

/**
 * Direct tests for the structured-field helpers. The round-trip tests cover the
 * happy path; these pin the malformed-input rejection branches and the string
 * escaping the signature base depends on.
 */

describe("serializeString", () => {
  it("double-quotes a plain string", () => {
    expect(serializeString("hello")).toBe('"hello"');
  });

  it("escapes backslashes and double-quotes", () => {
    expect(serializeString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe("parseSignatureInput rejects malformed input", () => {
  it("throws on an empty dictionary", () => {
    expect(() => parseSignatureInput("")).toThrow(SfParseError);
  });

  it("throws when a member has no value", () => {
    expect(() => parseSignatureInput("sig1")).toThrow(SfParseError);
  });

  it("throws when the value is not an inner list", () => {
    expect(() => parseSignatureInput('sig1="notalist"')).toThrow(SfParseError);
  });

  it("parses a valid labelled inner list with parameters", () => {
    const parsed = parseSignatureInput(
      'sig1=("@method" "@authority");created=1700000000;keyid="k"',
    );
    const entry = parsed.get("sig1");
    expect(entry).toBeDefined();
    expect(entry!.items.map((i) => i.value)).toEqual(["@method", "@authority"]);
  });
});

describe("parseSignatureHeader rejects malformed input", () => {
  it("throws on an empty dictionary", () => {
    expect(() => parseSignatureHeader("")).toThrow(SfParseError);
  });

  it("throws when a member has no value", () => {
    expect(() => parseSignatureHeader("sig1")).toThrow(SfParseError);
  });

  it("parses a labelled byte sequence", () => {
    const parsed = parseSignatureHeader("sig1=:AQID:");
    const bytes = parsed.get("sig1");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes!)).toEqual([1, 2, 3]);
  });
});
