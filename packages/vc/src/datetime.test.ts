import { describe, expect, it } from "vitest";

import { isValidXsdDateTimeStamp, toXsdDateTime } from "./datetime.js";

describe("isValidXsdDateTimeStamp", () => {
  it("accepts well-formed dateTimeStamps with a timezone", () => {
    expect(isValidXsdDateTimeStamp("2026-06-04T00:00:00Z")).toBe(true);
    expect(isValidXsdDateTimeStamp("2026-06-04T12:34:56.789Z")).toBe(true);
    expect(isValidXsdDateTimeStamp("2026-06-04T00:00:00+05:30")).toBe(true);
    expect(isValidXsdDateTimeStamp("2026-06-04T00:00:00-08:00")).toBe(true);
  });

  it("rejects a missing timezone (plain dateTime, not dateTimeStamp)", () => {
    expect(isValidXsdDateTimeStamp("2026-06-04T00:00:00")).toBe(false);
  });

  it("rejects malformed and impossible dates", () => {
    expect(isValidXsdDateTimeStamp("not-a-date")).toBe(false);
    expect(isValidXsdDateTimeStamp("2026-13-01T00:00:00Z")).toBe(false);
    expect(isValidXsdDateTimeStamp("2026-02-30T00:00:00Z")).toBe(false);
    expect(isValidXsdDateTimeStamp("")).toBe(false);
  });
});

describe("toXsdDateTime", () => {
  it("renders a Date in UTC at second precision", () => {
    expect(toXsdDateTime(new Date("2026-06-04T12:34:56.789Z"))).toBe(
      "2026-06-04T12:34:56Z",
    );
  });

  it("passes a valid string through unchanged", () => {
    expect(toXsdDateTime("2026-06-04T00:00:00+02:00")).toBe(
      "2026-06-04T00:00:00+02:00",
    );
  });

  it("throws on an invalid string", () => {
    expect(() => toXsdDateTime("not-a-date")).toThrow(/dateTimeStamp/);
    expect(() => toXsdDateTime("2026-06-04T00:00:00")).toThrow(/dateTimeStamp/);
  });
});
