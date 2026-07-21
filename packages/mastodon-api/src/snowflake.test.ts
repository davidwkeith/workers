import { describe, expect, it } from "vitest";

import { decodeSnowflake, encodeSnowflake } from "./snowflake.js";

describe("snowflake codec", () => {
  it("round-trips receivedAtMs exactly and seq modulo 32768", () => {
    const id = encodeSnowflake(1_753_000_000_000, 42);
    const decoded = decodeSnowflake(id);
    expect(decoded).toEqual({ receivedAtMs: 1_753_000_000_000, seqLow: 42 });
  });

  it("wraps seq at 32768", () => {
    const id = encodeSnowflake(1_753_000_000_000, 32768 + 42);
    expect(decodeSnowflake(id)).toEqual({
      receivedAtMs: 1_753_000_000_000,
      seqLow: 42,
    });
  });

  it("produces a decimal string with no leading source-bit ambiguity", () => {
    const id = encodeSnowflake(1_753_000_000_000, 0);
    expect(/^\d+$/.test(id)).toBe(true);
  });

  it("decode rejects non-numeric input", () => {
    expect(decodeSnowflake("not-a-number")).toBeNull();
    expect(decodeSnowflake("1")).not.toBeNull(); // small ids are still valid
  });

  it("orders chronologically as a string comparison would only work numerically, not lexically for varying digit counts — callers must compare as BigInt, not string", () => {
    const earlier = encodeSnowflake(1_753_000_000_000, 0);
    const later = encodeSnowflake(1_753_000_000_001, 0);
    expect(BigInt(later) > BigInt(earlier)).toBe(true);
  });
});
