import { describe, expect, it } from "vitest";

import { decodeFirst, CborError } from "./cbor";
import { encodeCbor } from "./test-harness";

describe("@dwk/webauthn cbor decoder", () => {
  it("decodes small unsigned integers inline", () => {
    expect(decodeFirst(new Uint8Array([0x00])).value).toBe(0);
    expect(decodeFirst(new Uint8Array([0x17])).value).toBe(23);
  });

  it("decodes multi-byte unsigned integers", () => {
    expect(decodeFirst(new Uint8Array([0x18, 0x18])).value).toBe(24);
    expect(decodeFirst(new Uint8Array([0x19, 0x01, 0x00])).value).toBe(256);
    expect(decodeFirst(new Uint8Array([0x1a, 0, 1, 0, 0])).value).toBe(65536);
  });

  it("decodes negative integers (COSE alg labels)", () => {
    // -7 (ES256): major 1, argument 6.
    expect(decodeFirst(new Uint8Array([0x26])).value).toBe(-7);
    // -257 (RS256): major 1, two-byte argument 256.
    expect(decodeFirst(new Uint8Array([0x39, 0x01, 0x00])).value).toBe(-257);
  });

  it("decodes byte and text strings", () => {
    const bytes = decodeFirst(new Uint8Array([0x43, 1, 2, 3])).value;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...(bytes as Uint8Array)]).toEqual([1, 2, 3]);
    expect(decodeFirst(encodeCbor("fmt")).value).toBe("fmt");
  });

  it("decodes maps preserving integer keys", () => {
    const cose = new Map<number, number>([
      [1, 2],
      [3, -7],
      [-1, 1],
    ]);
    const decoded = decodeFirst(encodeCbor(cose)).value;
    expect(decoded).toBeInstanceOf(Map);
    const map = decoded as Map<unknown, unknown>;
    expect(map.get(1)).toBe(2);
    expect(map.get(3)).toBe(-7);
    expect(map.get(-1)).toBe(1);
  });

  it("reports how many bytes were consumed (for trailing data)", () => {
    const buf = new Uint8Array([0x01, 0xff, 0xff]);
    const decoded = decodeFirst(buf);
    expect(decoded.value).toBe(1);
    expect(decoded.length).toBe(1);
  });

  it("decodes starting at an offset", () => {
    const buf = new Uint8Array([0xaa, 0xbb, 0x05]);
    expect(decodeFirst(buf, 2).value).toBe(5);
  });

  it("rejects truncated input and unsupported types", () => {
    expect(() => decodeFirst(new Uint8Array([0x43, 1]))).toThrow(CborError);
    // Major type 7 (simple/float) is unsupported.
    expect(() => decodeFirst(new Uint8Array([0xf6]))).toThrow(CborError);
  });
});
