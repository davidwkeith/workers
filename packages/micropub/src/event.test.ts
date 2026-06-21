import { describe, it, expect } from "vitest";
import { toICalendar, toJSCalendar } from "@dwk/calendar";
import {
  H_EVENT,
  isEvent,
  renderHEvent,
  hEventToCalendarEvent,
} from "./event.js";
import type { Mf2Object } from "./mf2.js";

/**
 * Extract a single mf2 property (text content or a chosen attribute) from
 * rendered markup using the runtime's `HTMLRewriter`, to confirm the output is
 * parseable back into the property it was rendered from. This is a focused
 * round-trip check, not a general mf2 parser.
 */
async function readProperty(
  html: string,
  cls: string,
  attr?: string,
): Promise<string[]> {
  const values: string[] = [];
  let text = "";
  let open = false;
  const rewriter = new HTMLRewriter().on(`[class~="${cls}"]`, {
    element(el) {
      if (attr !== undefined) {
        const value = el.getAttribute(attr);
        if (value !== null) values.push(value);
        return;
      }
      open = true;
      text = "";
      el.onEndTag(() => {
        values.push(text);
        open = false;
      });
    },
    text(chunk) {
      if (open) text += chunk.text;
    },
  });
  await rewriter.transform(new Response(html)).text();
  return values;
}

describe("isEvent", () => {
  it("recognizes the h-event type", () => {
    expect(isEvent({ type: [H_EVENT], properties: {} })).toBe(true);
    expect(isEvent({ type: ["h-entry"], properties: {} })).toBe(false);
  });
});

describe("renderHEvent", () => {
  const event: Mf2Object = {
    type: [H_EVENT],
    properties: {
      name: ["Indie Web Meetup"],
      start: ["2026-07-01T18:00:00-07:00"],
      end: ["2026-07-01T20:00:00-07:00"],
      location: ["Portland, OR"],
      category: ["indieweb", "meetup"],
    },
  };

  it("wraps the markup in an h-event root", () => {
    expect(renderHEvent(event)).toMatch(/^<div class="h-event">.*<\/div>$/s);
  });

  it("round-trips name/start/end/location through an HTML parser", async () => {
    const html = renderHEvent(event);
    expect(await readProperty(html, "p-name")).toEqual(["Indie Web Meetup"]);
    expect(await readProperty(html, "p-location")).toEqual(["Portland, OR"]);
    // dt-* values live on the `datetime` attribute of a <time> element.
    expect(await readProperty(html, "dt-start", "datetime")).toEqual([
      "2026-07-01T18:00:00-07:00",
    ]);
    expect(await readProperty(html, "dt-end", "datetime")).toEqual([
      "2026-07-01T20:00:00-07:00",
    ]);
  });

  it("emits each value of a multi-valued property", async () => {
    const html = renderHEvent(event);
    expect(await readProperty(html, "p-category")).toEqual([
      "indieweb",
      "meetup",
    ]);
  });

  it("renders url as a u-* anchor href", async () => {
    const html = renderHEvent({
      type: [H_EVENT],
      properties: { url: ["https://example.com/party"] },
    });
    expect(await readProperty(html, "u-url", "href")).toEqual([
      "https://example.com/party",
    ]);
  });

  it("emits e-content HTML verbatim and escapes plain-text values", () => {
    const withHtml = renderHEvent({
      type: [H_EVENT],
      properties: { content: [{ html: "<p>Bring <b>snacks</b></p>" }] },
    });
    expect(withHtml).toContain(
      '<div class="e-content"><p>Bring <b>snacks</b></p></div>',
    );
    const withText = renderHEvent({
      type: [H_EVENT],
      properties: { name: ["A & B <tag>"] },
    });
    expect(withText).toContain(
      '<span class="p-name">A &amp; B &lt;tag&gt;</span>',
    );
  });

  it("neutralizes a script-bearing url scheme in the href", async () => {
    const html = renderHEvent({
      type: [H_EVENT],
      properties: { url: ["javascript:alert(1)"] },
    });
    expect(await readProperty(html, "u-url", "href")).toEqual(["#"]);
    // An ordinary http(s) url is still emitted as-is.
    const ok = renderHEvent({
      type: [H_EVENT],
      properties: { url: ["https://example.com/e"] },
    });
    expect(await readProperty(ok, "u-url", "href")).toEqual([
      "https://example.com/e",
    ]);
  });

  it("tolerates a malformed mf2 object without throwing", () => {
    const bogus = { type: [H_EVENT] } as unknown as Mf2Object;
    expect(renderHEvent(bogus)).toBe('<div class="h-event"></div>');
    const nonArray = {
      type: [H_EVENT],
      properties: { name: "oops" },
    } as unknown as Mf2Object;
    expect(renderHEvent(nonArray)).toBe('<div class="h-event"></div>');
  });

  it("reads a nested location microformat's name", async () => {
    const html = renderHEvent({
      type: [H_EVENT],
      properties: {
        location: [{ type: ["h-card"], properties: { name: ["The Hall"] } }],
      },
    });
    expect(await readProperty(html, "p-location")).toEqual(["The Hall"]);
  });
});

describe("hEventToCalendarEvent", () => {
  const stored: Mf2Object = {
    type: [H_EVENT],
    properties: {
      uid: ["https://example.com/events/1"],
      url: ["https://example.com/events/1"],
      name: ["Park Cleanup"],
      summary: ["Bring gloves."],
      start: ["2026-07-01T18:00:00-07:00"],
      end: ["2026-07-01T20:00:00-07:00"],
      location: ["Civic Center"],
      category: ["volunteering", "outdoors"],
      published: ["2026-06-01T08:00:00Z"],
    },
  };

  it("maps the core h-event properties to the canonical model", () => {
    expect(hEventToCalendarEvent(stored)).toEqual({
      uid: "https://example.com/events/1",
      title: "Park Cleanup",
      description: "Bring gloves.",
      start: "2026-07-01T18:00:00-07:00",
      end: "2026-07-01T20:00:00-07:00",
      locations: [{ name: "Civic Center" }],
      keywords: ["volunteering", "outdoors"],
      links: [{ href: "https://example.com/events/1" }],
      created: "2026-06-01T08:00:00Z",
    });
  });

  it("falls back from uid to url for identity", () => {
    const event = hEventToCalendarEvent({
      type: [H_EVENT],
      properties: {
        url: ["https://example.com/events/9"],
        start: ["2026-07-04"],
      },
    });
    expect(event.uid).toBe("https://example.com/events/9");
  });

  it("uses content as the description when no summary is present", () => {
    const event = hEventToCalendarEvent({
      type: [H_EVENT],
      properties: {
        uid: ["u"],
        start: ["2026-07-04"],
        content: ["The long story."],
      },
    });
    expect(event.description).toBe("The long story.");
  });

  it("reads a nested location h-card name", () => {
    const event = hEventToCalendarEvent({
      type: [H_EVENT],
      properties: {
        uid: ["u"],
        start: ["2026-07-04"],
        location: [{ type: ["h-card"], properties: { name: ["The Hall"] } }],
      },
    });
    expect(event.locations).toEqual([{ name: "The Hall" }]);
  });

  it("throws when the event has neither uid nor url", () => {
    expect(() =>
      hEventToCalendarEvent({
        type: [H_EVENT],
        properties: { start: ["2026-07-04"] },
      }),
    ).toThrow(/stable identity/);
  });

  it("throws when the event has no start", () => {
    expect(() =>
      hEventToCalendarEvent({ type: [H_EVENT], properties: { uid: ["u"] } }),
    ).toThrow(/start/);
  });

  it("round-trips h-event → canonical model → .ics preserving the core fields", () => {
    const ics = toICalendar(hEventToCalendarEvent(stored), {
      now: new Date("2026-06-21T12:00:00Z"),
    });
    expect(ics).toContain("UID:https://example.com/events/1");
    expect(ics).toContain("SUMMARY:Park Cleanup");
    // -07:00 instants normalise to UTC.
    expect(ics).toContain("DTSTART:20260702T010000Z");
    expect(ics).toContain("DTEND:20260702T030000Z");
    expect(ics).toContain("LOCATION:Civic Center");
    expect(ics).toContain("CATEGORIES:volunteering,outdoors");
  });

  it("round-trips into a JSCalendar object with a derived duration", () => {
    const js = toJSCalendar(hEventToCalendarEvent(stored));
    expect(js["@type"]).toBe("Event");
    expect(js.uid).toBe("https://example.com/events/1");
    expect(js.duration).toBe("PT2H");
  });
});
