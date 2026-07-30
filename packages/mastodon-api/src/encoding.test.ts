import { describe, expect, it, vi } from "vitest";

import {
  randomToken,
  sha256Hex,
  timingSafeEqualHex,
  verifyPkceS256,
} from "./encoding.js";

describe("encoding", () => {
  it("mints 43-char base64url tokens without padding", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });

  it("hashes to lowercase hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("verifies an RFC 7636 appendix-B S256 pair", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
    expect(await verifyPkceS256("wrong-verifier", challenge)).toBe(false);
  });

  it("compares hex strings timing-safely", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abc")).toBe(false);
  });

  it("uses crypto.subtle.timingSafeEqual under the hood", () => {
    const spy = vi.spyOn(crypto.subtle, "timingSafeEqual");
    timingSafeEqualHex("ab".repeat(32), "ab".repeat(32));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
