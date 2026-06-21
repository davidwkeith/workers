import { describe, it, expect } from "vitest";
import * as calendar from "./index.js";

describe("@dwk/calendar public surface", () => {
  it("re-exports the model, serializers and feed handler", () => {
    expect(typeof calendar.assertSerializable).toBe("function");
    expect(typeof calendar.toICalDate).toBe("function");
    expect(typeof calendar.toInstant).toBe("function");
    expect(typeof calendar.formatUtc).toBe("function");
    expect(typeof calendar.toICalendar).toBe("function");
    expect(typeof calendar.toICalendarFeed).toBe("function");
    expect(typeof calendar.toVEventLines).toBe("function");
    expect(typeof calendar.toJSCalendar).toBe("function");
    expect(typeof calendar.createCalendarFeed).toBe("function");
  });

  it("round-trips a canonical event through both serializers", () => {
    const event = {
      uid: "round-trip@example.com",
      title: "Round Trip",
      start: "2026-07-01T18:00:00Z",
      end: "2026-07-01T19:00:00Z",
    };
    expect(calendar.toICalendar(event)).toContain("UID:round-trip@example.com");
    expect(calendar.toJSCalendar(event).duration).toBe("PT1H");
  });
});
