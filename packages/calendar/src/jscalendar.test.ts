import { describe, it, expect } from "vitest";
import { toJSCalendar } from "./jscalendar.js";

describe("toJSCalendar", () => {
  it("emits a JSCalendar Event with @type and core fields", () => {
    const js = toJSCalendar({
      uid: "event-1@example.com",
      title: "Park Cleanup",
      description: "Bring gloves.",
      start: "2026-07-01T18:00:00Z",
      end: "2026-07-01T19:30:00Z",
    });
    expect(js).toMatchObject({
      "@type": "Event",
      uid: "event-1@example.com",
      title: "Park Cleanup",
      description: "Bring gloves.",
      start: "2026-07-01T18:00:00",
      timeZone: "Etc/UTC",
      duration: "PT1H30M",
    });
  });

  it("normalises an offset start to UTC and derives the duration", () => {
    const js = toJSCalendar({
      uid: "u",
      start: "2026-07-01T18:00:00-07:00",
      end: "2026-07-01T20:00:00-07:00",
    });
    expect(js.start).toBe("2026-07-02T01:00:00");
    expect(js.timeZone).toBe("Etc/UTC");
    expect(js.duration).toBe("PT2H");
  });

  it("keeps a floating local start with its IANA time zone", () => {
    const js = toJSCalendar({
      uid: "u",
      start: "2026-07-01T18:00:00",
      timeZone: "America/Los_Angeles",
    });
    expect(js.start).toBe("2026-07-01T18:00:00");
    expect(js.timeZone).toBe("America/Los_Angeles");
    expect(js.showWithoutTime).toBeUndefined();
  });

  it("marks a date-only event all-day with showWithoutTime", () => {
    const js = toJSCalendar({ uid: "u", start: "2026-07-04" });
    expect(js.start).toBe("2026-07-04T00:00:00");
    expect(js.showWithoutTime).toBe(true);
    expect(js.timeZone).toBeUndefined();
  });

  it("prefers an explicit duration over deriving from end", () => {
    const js = toJSCalendar({
      uid: "u",
      start: "2026-07-01T18:00:00Z",
      end: "2026-07-01T23:00:00Z",
      duration: "PT15M",
    });
    expect(js.duration).toBe("PT15M");
  });

  it("omits duration for a zero/negative span", () => {
    const js = toJSCalendar({
      uid: "u",
      start: "2026-07-01T18:00:00Z",
      end: "2026-07-01T18:00:00Z",
    });
    expect(js.duration).toBeUndefined();
  });

  it("derives a multi-day duration with both date and time parts", () => {
    const js = toJSCalendar({
      uid: "u",
      start: "2026-07-01T18:00:00Z",
      end: "2026-07-03T20:30:00Z",
    });
    expect(js.duration).toBe("P2DT2H30M");
  });

  it("maps locations, keywords and links to JSCalendar id-maps", () => {
    const js = toJSCalendar({
      uid: "u",
      start: "2026-07-01T18:00:00Z",
      locations: [{ name: "Hall A" }, { name: "Hall B" }],
      keywords: ["music", "free"],
      links: [{ href: "https://example.com/e", rel: "alternate" }],
    });
    expect(js.locations).toEqual({
      "1": { "@type": "Location", name: "Hall A" },
      "2": { "@type": "Location", name: "Hall B" },
    });
    expect(js.keywords).toEqual({ music: true, free: true });
    expect(js.links).toEqual({
      "1": { "@type": "Link", href: "https://example.com/e", rel: "alternate" },
    });
  });

  it("carries status, created, updated and sequence", () => {
    const js = toJSCalendar({
      uid: "u",
      start: "2026-07-01T18:00:00Z",
      status: "tentative",
      created: "2026-06-01T08:00:00Z",
      updated: "2026-06-10T09:30:00-04:00",
      sequence: 2,
    });
    expect(js.status).toBe("tentative");
    expect(js.created).toBe("2026-06-01T08:00:00Z");
    expect(js.updated).toBe("2026-06-10T13:30:00Z");
    expect(js.sequence).toBe(2);
  });

  it("produces clean JSON with no undefined holes", () => {
    const js = toJSCalendar({ uid: "u", start: "2026-07-04" });
    expect(JSON.parse(JSON.stringify(js))).toEqual(js);
  });

  it("throws without a uid", () => {
    expect(() => toJSCalendar({ uid: "", start: "2026-07-04" })).toThrow(/uid/);
  });
});
