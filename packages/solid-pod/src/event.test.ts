import type { CalendarEvent } from "@dwk/calendar";
import { describe, expect, it } from "vitest";

import { calendarEventToQuads, quadsToCalendarEvent } from "./event.js";

const SCHEMA = "http://schema.org/";
const SUBJECT = "https://pod.example/cal/party";

/** Find the single literal/named-node object value for a predicate. */
function objectValue(
  quads: ReturnType<typeof calendarEventToQuads>,
  predicate: string,
): string | undefined {
  return quads.find((q) => q.predicate.value === `${SCHEMA}${predicate}`)
    ?.object.value;
}

describe("@dwk/solid-pod calendarEventToQuads", () => {
  it("renders schema.org triples about the resource subject", () => {
    const quads = calendarEventToQuads(
      {
        uid: "urn:uuid:1",
        title: "Launch Party",
        description: "Come celebrate",
        start: "2026-07-01T18:00:00Z",
        end: "2026-07-01T21:00:00Z",
        locations: [{ name: "Civic Center" }],
        keywords: ["party", "launch"],
        links: [{ href: "https://example.com/party" }],
        status: "confirmed",
      },
      SUBJECT,
    );

    // Every triple is about the resource subject in the default graph.
    for (const quad of quads) {
      expect(quad.subject).toEqual({ termType: "NamedNode", value: SUBJECT });
      expect(quad.graph.termType).toBe("DefaultGraph");
    }

    expect(
      quads.some(
        (q) =>
          q.predicate.value ===
            "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" &&
          q.object.value === `${SCHEMA}Event`,
      ),
    ).toBe(true);
    expect(objectValue(quads, "identifier")).toBe("urn:uuid:1");
    expect(objectValue(quads, "name")).toBe("Launch Party");
    expect(objectValue(quads, "startDate")).toBe("2026-07-01T18:00:00Z");
    expect(objectValue(quads, "eventStatus")).toBe(`${SCHEMA}EventScheduled`);

    // Repeated properties produce one triple each.
    expect(
      quads.filter((q) => q.predicate.value === `${SCHEMA}keywords`),
    ).toHaveLength(2);
  });

  it("types a date-only start as xsd:date and a date-time as xsd:dateTime", () => {
    const allDay = calendarEventToQuads(
      { uid: "u", start: "2026-07-01" },
      SUBJECT,
    );
    expect(
      allDay.find((q) => q.predicate.value === `${SCHEMA}startDate`)?.object
        .datatype,
    ).toBe("http://www.w3.org/2001/XMLSchema#date");

    const timed = calendarEventToQuads(
      { uid: "u", start: "2026-07-01T09:00:00Z" },
      SUBJECT,
    );
    expect(
      timed.find((q) => q.predicate.value === `${SCHEMA}startDate`)?.object
        .datatype,
    ).toBe("http://www.w3.org/2001/XMLSchema#dateTime");
  });

  it("omits a status schema.org cannot express (tentative)", () => {
    const quads = calendarEventToQuads(
      { uid: "u", start: "2026-07-01T09:00:00Z", status: "tentative" },
      SUBJECT,
    );
    expect(objectValue(quads, "eventStatus")).toBeUndefined();
  });

  it("rejects an event the calendar model would reject", () => {
    expect(() =>
      calendarEventToQuads({ uid: "", start: "2026-07-01" }, SUBJECT),
    ).toThrow(/uid/);
    expect(() =>
      calendarEventToQuads(
        {
          uid: "u",
          start: "2026-07-01T21:00:00Z",
          end: "2026-07-01T18:00:00Z",
        },
        SUBJECT,
      ),
    ).toThrow(/before/);
  });
});

describe("@dwk/solid-pod quadsToCalendarEvent", () => {
  it("round-trips the core properties without loss", () => {
    const original: CalendarEvent = {
      uid: "urn:uuid:42",
      title: "Launch Party",
      description: "Come celebrate",
      start: "2026-07-01T18:00:00Z",
      end: "2026-07-01T21:00:00Z",
      locations: [{ name: "Civic Center" }, { name: "Room 12" }],
      keywords: ["party", "launch"],
      links: [{ href: "https://example.com/party" }],
      status: "cancelled",
      created: "2026-06-01T00:00:00Z",
      updated: "2026-06-15T00:00:00Z",
    };
    const restored = quadsToCalendarEvent(
      calendarEventToQuads(original, SUBJECT),
      SUBJECT,
    );
    expect(restored).toEqual(original);
  });

  it("round-trips an all-day event", () => {
    const original: CalendarEvent = {
      uid: "u",
      title: "Holiday",
      start: "2026-12-25",
      end: "2026-12-26",
    };
    expect(
      quadsToCalendarEvent(calendarEventToQuads(original, SUBJECT), SUBJECT),
    ).toEqual(original);
  });

  it("falls back to the subject IRI when no schema:identifier is present", () => {
    const event = quadsToCalendarEvent(
      [
        {
          subject: { termType: "NamedNode", value: SUBJECT },
          predicate: { termType: "NamedNode", value: `${SCHEMA}startDate` },
          object: {
            termType: "Literal",
            value: "2026-07-01T09:00:00Z",
            datatype: "http://www.w3.org/2001/XMLSchema#dateTime",
          },
          graph: { termType: "DefaultGraph", value: "" },
        },
      ],
      SUBJECT,
    );
    expect(event.uid).toBe(SUBJECT);
    expect(event.start).toBe("2026-07-01T09:00:00Z");
  });

  it("ignores triples about a different subject", () => {
    const quads = [
      ...calendarEventToQuads(
        { uid: "mine", start: "2026-07-01T09:00:00Z", title: "Mine" },
        SUBJECT,
      ),
      ...calendarEventToQuads(
        { uid: "other", start: "2026-08-01T09:00:00Z", title: "Other" },
        "https://pod.example/cal/other",
      ),
    ];
    const event = quadsToCalendarEvent(quads, SUBJECT);
    expect(event.uid).toBe("mine");
    expect(event.title).toBe("Mine");
  });

  it("reads https://schema.org/ predicates and status IRIs", () => {
    const HTTPS = "https://schema.org/";
    const event = quadsToCalendarEvent(
      [
        {
          subject: { termType: "NamedNode", value: SUBJECT },
          predicate: { termType: "NamedNode", value: `${HTTPS}identifier` },
          object: {
            termType: "Literal",
            value: "urn:uuid:https",
            datatype: "http://www.w3.org/2001/XMLSchema#string",
          },
          graph: { termType: "DefaultGraph", value: "" },
        },
        {
          subject: { termType: "NamedNode", value: SUBJECT },
          predicate: { termType: "NamedNode", value: `${HTTPS}startDate` },
          object: {
            termType: "Literal",
            value: "2026-07-01T09:00:00Z",
            datatype: "http://www.w3.org/2001/XMLSchema#dateTime",
          },
          graph: { termType: "DefaultGraph", value: "" },
        },
        {
          subject: { termType: "NamedNode", value: SUBJECT },
          predicate: { termType: "NamedNode", value: `${HTTPS}eventStatus` },
          object: { termType: "NamedNode", value: `${HTTPS}EventScheduled` },
          graph: { termType: "DefaultGraph", value: "" },
        },
      ],
      SUBJECT,
    );
    expect(event.uid).toBe("urn:uuid:https");
    expect(event.start).toBe("2026-07-01T09:00:00Z");
    expect(event.status).toBe("confirmed");
  });

  it("throws when no startDate is present", () => {
    expect(() =>
      quadsToCalendarEvent(
        [
          {
            subject: { termType: "NamedNode", value: SUBJECT },
            predicate: { termType: "NamedNode", value: `${SCHEMA}name` },
            object: { termType: "Literal", value: "No start", datatype: "" },
            graph: { termType: "DefaultGraph", value: "" },
          },
        ],
        SUBJECT,
      ),
    ).toThrow(/startDate/);
  });
});
