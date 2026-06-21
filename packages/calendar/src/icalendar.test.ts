import { describe, it, expect } from "vitest";
import { toICalendar, toICalendarFeed, toVEventLines } from "./icalendar.js";
import type { CalendarEvent } from "./model.js";

const NOW = new Date("2026-06-21T12:00:00Z");

const sample: CalendarEvent = {
  uid: "event-1@example.com",
  title: "Park Cleanup",
  description: "Bring gloves.",
  start: "2026-07-01T18:00:00-07:00",
  end: "2026-07-01T20:00:00-07:00",
  locations: [{ name: "Civic Center" }],
  keywords: ["volunteering", "outdoors"],
  links: [{ href: "https://example.com/events/1" }],
};

/** Parse an iCalendar string into unfolded property lines for assertions. */
function unfold(ics: string): string[] {
  return ics
    .replace(/\r\n[ \t]/g, "") // undo line folding
    .split("\r\n")
    .filter(Boolean);
}

describe("toICalendar", () => {
  it("wraps a single event in a valid VCALENDAR with CRLF and a trailing CRLF", () => {
    const ics = toICalendar(sample, { now: NOW });
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.includes("\n") && !ics.includes("\n\n")).toBe(true);
    const lines = unfold(ics);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("PRODID:-//dwk//@dwk/workers calendar//EN");
    expect(lines).toContain("CALSCALE:GREGORIAN");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
  });

  it("never emits METHOD (subscription-friendly)", () => {
    expect(toICalendar(sample, { now: NOW })).not.toMatch(/\r\nMETHOD:/);
  });

  it("emits the core VEVENT properties with normalised UTC instants", () => {
    const lines = unfold(toICalendar(sample, { now: NOW }));
    expect(lines).toContain("BEGIN:VEVENT");
    expect(lines).toContain("UID:event-1@example.com");
    expect(lines).toContain("DTSTAMP:20260621T120000Z");
    expect(lines).toContain("DTSTART:20260702T010000Z");
    expect(lines).toContain("DTEND:20260702T030000Z");
    expect(lines).toContain("SUMMARY:Park Cleanup");
    expect(lines).toContain("DESCRIPTION:Bring gloves.");
    expect(lines).toContain("LOCATION:Civic Center");
    expect(lines).toContain("CATEGORIES:volunteering,outdoors");
    expect(lines).toContain("URL:https://example.com/events/1");
    expect(lines).toContain("END:VEVENT");
  });

  it("uses a custom PRODID and calendar name", () => {
    const ics = toICalendar(sample, {
      now: NOW,
      prodId: "-//acme//cal//EN",
      calName: "Community Events",
      refreshInterval: "PT12H",
    });
    const lines = unfold(ics);
    expect(lines).toContain("PRODID:-//acme//cal//EN");
    expect(lines).toContain("NAME:Community Events");
    expect(lines).toContain("X-WR-CALNAME:Community Events");
    expect(lines).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT12H");
  });
});

describe("VEVENT timing forms", () => {
  it("emits VALUE=DATE for an all-day event", () => {
    const lines = toVEventLines(
      { uid: "u", start: "2026-07-04", end: "2026-07-05" },
      NOW,
    );
    expect(lines).toContain("DTSTART;VALUE=DATE:20260704");
    expect(lines).toContain("DTEND;VALUE=DATE:20260705");
  });

  it("prefers DURATION over DTEND when a duration is set", () => {
    const lines = toVEventLines(
      { uid: "u", start: "2026-07-01T18:00:00Z", duration: "PT90M" },
      NOW,
    );
    expect(lines).toContain("DURATION:PT90M");
    expect(lines.some((l) => l.startsWith("DTEND"))).toBe(false);
  });

  it("attaches TZID for a floating local time with a zone", () => {
    const lines = toVEventLines(
      { uid: "u", start: "2026-07-01T18:00:00", timeZone: "America/New_York" },
      NOW,
    );
    expect(lines).toContain("DTSTART;TZID=America/New_York:20260701T180000");
  });

  it("emits STATUS, SEQUENCE, CREATED and LAST-MODIFIED when present", () => {
    const lines = toVEventLines(
      {
        uid: "u",
        start: "2026-07-01T18:00:00Z",
        status: "cancelled",
        sequence: 3,
        created: "2026-06-01T08:00:00Z",
        updated: "2026-06-10T09:30:00Z",
      },
      NOW,
    );
    expect(lines).toContain("STATUS:CANCELLED");
    expect(lines).toContain("SEQUENCE:3");
    expect(lines).toContain("CREATED:20260601T080000Z");
    expect(lines).toContain("LAST-MODIFIED:20260610T093000Z");
  });
});

describe("RFC 5545 escaping and folding", () => {
  it("escapes commas, semicolons, backslashes and newlines in TEXT", () => {
    const lines = unfold(
      toICalendar(
        {
          uid: "u",
          start: "2026-07-01T18:00:00Z",
          title: "A; B, C \\ D\nE",
        },
        { now: NOW },
      ),
    );
    expect(lines).toContain("SUMMARY:A\\; B\\, C \\\\ D\\nE");
  });

  it("escapes each CATEGORIES value but keeps the list separators literal", () => {
    const lines = unfold(
      toICalendar(
        { uid: "u", start: "2026-07-01T18:00:00Z", keywords: ["a,b", "c"] },
        { now: NOW },
      ),
    );
    expect(lines).toContain("CATEGORIES:a\\,b,c");
  });

  it("folds a long content line at 75 octets with a leading space", () => {
    const longTitle = "x".repeat(200);
    const ics = toICalendar(
      { uid: "u", start: "2026-07-01T18:00:00Z", title: longTitle },
      { now: NOW },
    );
    // Every physical line must be <= 75 octets.
    const encoder = new TextEncoder();
    for (const line of ics.split("\r\n")) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
    // And unfolding restores the full SUMMARY.
    expect(unfold(ics)).toContain(`SUMMARY:${longTitle}`);
  });

  it("does not split a multi-byte character across a fold", () => {
    const ics = toICalendar(
      { uid: "u", start: "2026-07-01T18:00:00Z", title: "🎉".repeat(40) },
      { now: NOW },
    );
    // Re-joining must reproduce the emoji intact (no replacement chars).
    expect(unfold(ics)).toContain(`SUMMARY:${"🎉".repeat(40)}`);
  });
});

describe("toICalendarFeed", () => {
  it("renders multiple VEVENTs in one VCALENDAR with a shared DTSTAMP", () => {
    const ics = toICalendarFeed(
      [
        { uid: "a", start: "2026-07-01T18:00:00Z", title: "One" },
        { uid: "b", start: "2026-07-02T18:00:00Z", title: "Two" },
      ],
      { now: NOW },
    );
    const lines = unfold(ics);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(2);
    expect(lines.filter((l) => l === "DTSTAMP:20260621T120000Z")).toHaveLength(
      2,
    );
    expect(lines).toContain("UID:a");
    expect(lines).toContain("UID:b");
  });

  it("is byte-identical when regenerated with the same fixed clock", () => {
    const events = [{ uid: "a", start: "2026-07-01T18:00:00Z" }];
    expect(toICalendarFeed(events, { now: NOW })).toBe(
      toICalendarFeed(events, { now: NOW }),
    );
  });
});

describe("validation", () => {
  it("throws when an event has no uid", () => {
    expect(() =>
      toICalendar({ uid: "", start: "2026-07-01T18:00:00Z" }),
    ).toThrow(/uid/);
  });
});
