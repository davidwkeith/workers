import { describe, it, expect } from "vitest";
import { createCalendarFeed } from "./feed.js";
import type { CalendarEvent } from "./model.js";

const events: CalendarEvent[] = [
  { uid: "a", start: "2026-07-01T18:00:00Z", title: "One" },
  { uid: "b", start: "2026-07-02T18:00:00Z", title: "Two" },
];
const NOW = () => new Date("2026-06-21T12:00:00Z");

describe("createCalendarFeed", () => {
  it("throws when no events resolver is supplied", () => {
    // @ts-expect-error intentionally missing required config
    expect(() => createCalendarFeed({})).toThrow(/events/);
  });

  it("serves text/calendar with subscription headers on GET", async () => {
    const handler = createCalendarFeed({ events: () => events, now: NOW });
    const res = await handler(new Request("https://example.com/calendar.ics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="calendar.ics"',
    );
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    const body = await res.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("UID:a");
    expect(body).toContain("UID:b");
  });

  it("honors a custom filename, cache policy, prodId and calendar name", async () => {
    const handler = createCalendarFeed({
      events: () => events,
      now: NOW,
      filename: "community.ics",
      cacheControl: "no-store",
      prodId: "-//acme//cal//EN",
      calName: "Community",
    });
    const res = await handler(new Request("https://example.com/feed"));
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="community.ics"',
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("PRODID:-//acme//cal//EN");
    expect(body).toContain("X-WR-CALNAME:Community");
  });

  it("resolves events from the request (async resolver)", async () => {
    const handler = createCalendarFeed({
      now: NOW,
      events: async (request) => {
        const url = new URL(request.url);
        return url.searchParams.get("cat") === "music"
          ? [{ uid: "m", start: "2026-08-01T18:00:00Z", title: "Gig" }]
          : [];
      },
    });
    const res = await handler(
      new Request("https://example.com/feed?cat=music"),
    );
    const body = await res.text();
    expect(body).toContain("UID:m");
    expect(body).toContain("SUMMARY:Gig");
  });

  it("returns headers but no body for HEAD", async () => {
    const handler = createCalendarFeed({ events: () => events, now: NOW });
    const res = await handler(
      new Request("https://example.com/calendar.ics", { method: "HEAD" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(await res.text()).toBe("");
  });

  it("rejects non-GET/HEAD methods with 405 and an Allow header", async () => {
    const handler = createCalendarFeed({ events: () => events });
    const res = await handler(
      new Request("https://example.com/calendar.ics", { method: "POST" }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
  });
});
