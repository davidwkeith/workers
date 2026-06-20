import { describe, expect, it } from "vitest";

import { encodeTid, isValidTid, TidClock } from "./tid";

describe("TID", () => {
  it("produces 13-character base32-sortable identifiers", () => {
    const tid = encodeTid(1_700_000_000_000_000, 42);
    expect(tid.length).toBe(13);
    expect(isValidTid(tid)).toBe(true);
  });

  it("is monotonic and strictly increasing even within one clock tick", () => {
    const clock = new TidClock({ clockId: 1, now: () => 1_700_000_000_000 });
    const a = clock.next();
    const b = clock.next();
    const c = clock.next();
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it("sorts chronologically as plain strings", () => {
    const earlier = encodeTid(1_000_000, 0);
    const later = encodeTid(2_000_000, 0);
    expect(earlier < later).toBe(true);
  });

  it("rejects malformed TIDs", () => {
    expect(isValidTid("nope")).toBe(false);
    expect(isValidTid("3jui7kd54zh2y")).toBe(true);
  });
});
