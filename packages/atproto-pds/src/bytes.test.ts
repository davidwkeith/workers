import { describe, expect, it } from "vitest";

import { base64urlDecode, base64urlEncode, fromHex, toHex } from "./bytes.js";

describe("hex", () => {
  it("round-trips bytes through toHex/fromHex", () => {
    const bytes = Uint8Array.from([0x00, 0x0f, 0xa0, 0xff, 0x42]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it("accepts upper- and lower-case", () => {
    expect(fromHex("DEADbeef")).toEqual(
      Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    );
  });

  it("rejects an odd-length string", () => {
    expect(() => fromHex("abc")).toThrow(/odd-length/);
  });

  it("rejects invalid characters instead of silently truncating", () => {
    // Number.parseInt("1g", 16) === 1, so a per-slice NaN check would let this
    // through; the whole-string regex guard must reject it.
    expect(() => fromHex("1g")).toThrow(/invalid character/);
    expect(() => fromHex("zz")).toThrow(/invalid character/);
    expect(() => fromHex("00ff zz")).toThrow();
  });
});

describe("base64url", () => {
  it("round-trips and emits unpadded, URL-safe output", () => {
    // 64 bytes → 86 base64 chars (not a multiple of 4, i.e. normally padded).
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) & 0xff);
    const encoded = base64urlEncode(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, no '=' padding
    expect(encoded.length % 4).not.toBe(0); // would need padding to decode
    expect(base64urlDecode(encoded)).toEqual(bytes);
  });

  it("decodes regardless of restored padding length", () => {
    for (let n = 1; n <= 6; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => i + 1);
      expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes);
    }
  });
});
