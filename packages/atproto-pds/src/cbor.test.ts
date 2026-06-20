import { describe, expect, it } from "vitest";

import { decodeCbor, encodeCbor, type CborValue } from "./cbor";
import { CID, DAG_CBOR_CODEC } from "./cid";
import { toHex } from "./bytes";

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

  it("rejects trailing bytes", () => {
    const bytes = new Uint8Array([0x01, 0x02]);
    expect(() => decodeCbor(bytes)).toThrow();
  });
});
