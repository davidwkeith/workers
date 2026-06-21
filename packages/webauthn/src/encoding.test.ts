import { describe, expect, it } from "vitest";

import {
  base64urlToBytes,
  bytesEqual,
  bytesToBase64url,
  bytesToUtf8,
  normalizeBase64url,
  sha256,
  utf8ToBytes,
} from "./encoding.js";

describe("@dwk/webauthn encoding", () => {
  it("round-trips bytes through base64url", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = bytesToBase64url(bytes);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(bytesEqual(base64urlToBytes(encoded), bytes)).toBe(true);
  });

  it("decodes padded standard base64 too", () => {
    // "Ma" encodes [0x31, 0x9a-ish]; assert standard + url forms decode equal.
    const bytes = new Uint8Array([0xff, 0xef, 0xbe]);
    const url = bytesToBase64url(bytes);
    const std = btoa("\xff\xef\xbe");
    expect(bytesEqual(base64urlToBytes(url), bytes)).toBe(true);
    expect(bytesEqual(base64urlToBytes(std), bytes)).toBe(true);
  });

  it("normalizes base64url to a comparable form", () => {
    expect(normalizeBase64url("ab-_cd==")).toBe("ab+/cd");
    expect(normalizeBase64url("abcd")).toBe("abcd");
  });

  it("compares byte arrays for equality", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(
      true,
    );
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(
      false,
    );
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it("round-trips utf-8", () => {
    expect(bytesToUtf8(utf8ToBytes("héllo ✓"))).toBe("héllo ✓");
  });

  it("computes a SHA-256 digest of the expected length", async () => {
    const digest = await sha256(utf8ToBytes("abc"));
    expect(digest).toHaveLength(32);
    // NIST SHA-256("abc") begins with ba7816bf...
    expect(bytesToBase64url(digest)).toBe(
      "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
    );
  });
});
