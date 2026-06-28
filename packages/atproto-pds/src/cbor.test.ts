import { describe, expect, it } from "vitest";

import { decodeCbor, encodeCbor, type CborValue } from "./cbor.js";
import { CID, DAG_CBOR_CODEC } from "./cid.js";
import { toHex } from "./bytes.js";

describe("DAG-CBOR", () => {
  it("encodes a small map to the canonical bytes", () => {
    expect(toHex(encodeCbor({ a: 1 }))).toBe("a1616101");
  });

  it("sorts map keys bytewise when lengths are equal", () => {
    // { b: 1, a: 2 } -> a before b: a2 61 61 02 61 62 01
    expect(toHex(encodeCbor({ b: 1, a: 2 }))).toBe("a2616102616201");
  });

  it("sorts map keys length-first (shorter keys come first)", () => {
    // { aa: 1, b: 2 } -> b (len 1) before aa (len 2):
    // a2 (61 62) 02 (62 61 61) 01
    expect(toHex(encodeCbor({ aa: 1, b: 2 }))).toBe("a261620262616101");
  });

  it("round-trips the value model", () => {
    const value: CborValue = {
      str: "hello",
      n: 42,
      neg: -7,
      yes: true,
      no: false,
      nothing: null,
      list: [1, 2, 3],
      bytes: new Uint8Array([1, 2, 3, 255]),
      nested: { x: 1 },
    };
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });

  it("drops undefined fields", () => {
    expect(toHex(encodeCbor({ a: 1, b: undefined as never }))).toBe("a1616101");
  });

  it("encodes a CID link as tag 42", async () => {
    const cid = await CID.create(DAG_CBOR_CODEC, encodeCbor({ a: 1 }));
    const decoded = decodeCbor(encodeCbor({ link: cid }));
    const link = (decoded as { link: CID }).link;
    expect(link).toBeInstanceOf(CID);
    expect(link.toString()).toBe(cid.toString());
  });

  it("rejects unsafe integers", () => {
    expect(() => encodeCbor(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("rejects floats on encode (the atproto data model forbids them)", () => {
    expect(() => encodeCbor(1.5)).toThrow(/floats are not supported/);
    expect(() => encodeCbor(Infinity)).toThrow(/floats are not supported/);
    expect(() => encodeCbor(NaN)).toThrow(/floats are not supported/);
  });

  it("rejects a float64 head on decode", () => {
    // 0xfb = major 7 / additional info 27 (float64); 1.5 = 3ff8000000000000.
    const bytes = new Uint8Array([0xfb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0]);
    expect(() => decodeCbor(bytes)).toThrow(/floats are not supported/);
  });

  it("rejects a non-minimally-encoded integer", () => {
    // 0x18 0x05 encodes 5 with a one-byte follow; 5 < 24 must be inline (0x05).
    expect(() => decodeCbor(new Uint8Array([0x18, 0x05]))).toThrow(
      /not minimally encoded/,
    );
  });

  it("rejects out-of-order map keys", () => {
    // { b: 1, a: 2 } in wire order b-then-a — a2 (61 62) 01 (61 61) 02.
    const bytes = new Uint8Array([0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02]);
    expect(() => decodeCbor(bytes)).toThrow(/out of order or duplicated/);
  });

  it("rejects duplicate map keys", () => {
    // key "a" twice — a2 (61 61) 01 (61 61) 02.
    const bytes = new Uint8Array([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]);
    expect(() => decodeCbor(bytes)).toThrow(/out of order or duplicated/);
  });

  it("rejects trailing bytes", () => {
    const bytes = new Uint8Array([0x01, 0x02]);
    expect(() => decodeCbor(bytes)).toThrow();
  });

  it("rejects truncated input with a clear end-of-input error", () => {
    // A map header claiming one entry, but no key/value follows.
    expect(() => decodeCbor(new Uint8Array([0xa1]))).toThrow(
      /unexpected end of input/,
    );
    // A byte string claiming 4 bytes with none present.
    expect(() => decodeCbor(new Uint8Array([0x44]))).toThrow(
      /unexpected end of input/,
    );
    // Empty input.
    expect(() => decodeCbor(new Uint8Array([]))).toThrow(
      /unexpected end of input/,
    );
  });
});
