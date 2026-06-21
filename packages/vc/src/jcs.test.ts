import { describe, expect, it } from "vitest";

import { canonicalize, canonicalizeToBytes } from "./jcs.js";

describe("canonicalize (RFC 8785)", () => {
  it("sorts object keys by UTF-16 code unit", () => {
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it("sorts nested objects recursively and preserves array order", () => {
    const value = { z: [3, 1, 2], a: { y: 1, x: 2 } };
    expect(canonicalize(value)).toBe('{"a":{"x":2,"y":1},"z":[3,1,2]}');
  });

  it("drops undefined members but keeps null", () => {
    expect(canonicalize({ a: undefined, b: null, c: 1 })).toBe(
      '{"b":null,"c":1}',
    );
  });

  it("serializes undefined array elements as null (like JSON)", () => {
    expect(canonicalize([1, undefined as never, 3])).toBe("[1,null,3]");
  });

  it("escapes strings like JSON.stringify", () => {
    expect(canonicalize('a"b\n')).toBe('"a\\"b\\n"');
  });

  it("normalizes -0 to 0", () => {
    expect(canonicalize(-0)).toBe("0");
  });

  it("throws on non-finite numbers", () => {
    expect(() => canonicalize(Infinity)).toThrow(/non-finite/);
    expect(() => canonicalize(NaN)).toThrow(/non-finite/);
  });

  it("is deterministic regardless of insertion order", () => {
    const a = canonicalize({ one: 1, two: 2, three: 3 });
    const b = canonicalize({ three: 3, two: 2, one: 1 });
    expect(a).toBe(b);
  });

  it("encodes to UTF-8 bytes", () => {
    const bytes = canonicalizeToBytes({ a: 1 });
    expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
  });
});
