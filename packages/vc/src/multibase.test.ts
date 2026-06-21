import { describe, expect, it } from "vitest";

import {
  base58btcDecode,
  base58btcEncode,
  base64urlDecode,
  base64urlEncode,
  decodeMultibase,
  decodeMultikey,
  encodeEd25519Multikey,
  encodeMultibaseBase58btc,
  encodeMultibaseBase64url,
} from "./multibase.js";

describe("base58btc", () => {
  it("round-trips arbitrary bytes", () => {
    for (let i = 0; i < 50; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(i));
      expect([...base58btcDecode(base58btcEncode(bytes))]).toEqual([...bytes]);
    }
  });

  it("matches known Bitcoin base58 vectors", () => {
    // "Hello World!" → base58
    const hello = new TextEncoder().encode("Hello World!");
    expect(base58btcEncode(hello)).toBe("2NEpo7TZRRrLZSi2U");
  });

  it("preserves leading zero bytes as leading '1's", () => {
    const bytes = Uint8Array.of(0, 0, 1, 2, 3);
    const encoded = base58btcEncode(bytes);
    expect(encoded.startsWith("11")).toBe(true);
    expect([...base58btcDecode(encoded)]).toEqual([...bytes]);
  });

  it("rejects an out-of-alphabet character", () => {
    expect(() => base58btcDecode("0OIl")).toThrow(/invalid base58/);
  });
});

describe("base64url", () => {
  it("round-trips bytes without padding", () => {
    const bytes = Uint8Array.of(1, 2, 3, 4, 5);
    const encoded = base64urlEncode(bytes);
    expect(encoded).not.toContain("=");
    expect([...base64urlDecode(encoded)]).toEqual([...bytes]);
  });
});

describe("multibase dispatch", () => {
  it("encodes and decodes base58-btc (z) and base64url (u)", () => {
    const bytes = Uint8Array.of(9, 8, 7, 6);
    const z = encodeMultibaseBase58btc(bytes);
    const u = encodeMultibaseBase64url(bytes);
    expect(z[0]).toBe("z");
    expect(u[0]).toBe("u");
    expect([...decodeMultibase(z)]).toEqual([...bytes]);
    expect([...decodeMultibase(u)]).toEqual([...bytes]);
  });

  it("rejects an unknown multibase prefix", () => {
    expect(() => decodeMultibase("x123")).toThrow(/unsupported multibase/);
  });
});

describe("Ed25519 Multikey", () => {
  it("round-trips a raw key with the multicodec prefix", () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const multibase = encodeEd25519Multikey(raw);
    // Multikey for Ed25519 always starts with "z6Mk".
    expect(multibase.startsWith("z6Mk")).toBe(true);
    const decoded = decodeMultikey(multibase);
    expect(decoded.keyType).toBe("Ed25519");
    expect([...decoded.rawPublicKey]).toEqual([...raw]);
  });

  it("rejects a wrongly sized Ed25519 key", () => {
    expect(() => encodeEd25519Multikey(new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it("rejects a non-Ed25519 multicodec prefix", () => {
    // base58 of bytes whose prefix is not the Ed25519 multicodec.
    const bogus = encodeMultibaseBase58btc(Uint8Array.of(0x12, 0x00, 1, 2, 3));
    expect(() => decodeMultikey(bogus)).toThrow(/unsupported or malformed/);
  });
});
