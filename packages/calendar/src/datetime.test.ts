import { describe, it, expect } from "vitest";
import { toICalDate, toInstant, formatUtc } from "./datetime.js";

describe("toICalDate", () => {
  it("renders a date-only value as VALUE=DATE", () => {
    expect(toICalDate("2026-07-01")).toEqual({
      value: "20260701",
      params: ";VALUE=DATE",
    });
  });

  it("renders a UTC date-time as a Z instant", () => {
    expect(toICalDate("2026-07-01T18:30:00Z")).toEqual({
      value: "20260701T183000Z",
      params: "",
    });
  });

  it("normalises a numeric offset to a UTC instant", () => {
    // 18:00 at -07:00 is 01:00Z the next day.
    expect(toICalDate("2026-07-01T18:00:00-07:00")).toEqual({
      value: "20260702T010000Z",
      params: "",
    });
  });

  it("keeps a floating wall clock and attaches TZID when a zone is given", () => {
    expect(toICalDate("2026-07-01T18:00:00", "America/Los_Angeles")).toEqual({
      value: "20260701T180000",
      params: ";TZID=America/Los_Angeles",
    });
  });

  it("leaves a floating value zoneless with no time zone", () => {
    expect(toICalDate("2026-07-01T18:00:00")).toEqual({
      value: "20260701T180000",
      params: "",
    });
  });

  it("defaults missing seconds to 00 and accepts a space separator", () => {
    expect(toICalDate("2026-07-01 18:00")).toEqual({
      value: "20260701T180000",
      params: "",
    });
  });

  it("throws on an unparseable value", () => {
    expect(() => toICalDate("not-a-date")).toThrow(/unparseable/);
  });

  it("throws on an in-format but out-of-range date the regex admits", () => {
    expect(() => toICalDate("2026-13-45")).toThrow(/invalid/);
    expect(() => toICalDate("2026-02-30T25:00:00Z")).toThrow(/invalid/);
  });

  it("accepts a space separator alongside an offset", () => {
    expect(toICalDate("2026-07-01 18:00:00-07:00")).toEqual({
      value: "20260702T010000Z",
      params: "",
    });
  });
});

describe("toInstant", () => {
  it("parses an offset date-time to the correct UTC instant", () => {
    const d = toInstant("2026-07-01T18:00:00-07:00");
    expect(d && formatUtc(d)).toBe("20260702T010000Z");
  });

  it("reads a floating date-time as UTC", () => {
    const d = toInstant("2026-07-01T18:00:00");
    expect(d && formatUtc(d)).toBe("20260701T180000Z");
  });

  it("reads a date-only value as UTC midnight", () => {
    const d = toInstant("2026-07-01");
    expect(d && formatUtc(d)).toBe("20260701T000000Z");
  });

  it("returns null for garbage", () => {
    expect(toInstant("nope")).toBeNull();
  });
});
