import { describe, expect, it } from "vitest";

import { fromHex, toHex } from "./bytes.js";

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
