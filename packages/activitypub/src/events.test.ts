import { describe, expect, it } from "vitest";

import type { CalendarEvent } from "@dwk/calendar";

import {
  calendarEventToActivityStreams,
  participationTarget,
} from "./events.js";

const EVENT: CalendarEvent = {
  uid: "picnic-2026",
  title: "Summer Picnic",
  description: "Bring a dish to share.",
  start: "2026-07-04T17:00:00Z",
  end: "2026-07-04T21:00:00Z",
  locations: [{ name: "Civic Center, Room 12" }],
  keywords: ["community", "food"],
  links: [{ href: "https://social.example/events/picnic" }],
  created: "2026-06-01T00:00:00Z",
  updated: "2026-06-15T00:00:00Z",
};

describe("calendarEventToActivityStreams", () => {
  it("maps the canonical event to an AS2 Event with core properties", () => {
    const doc = calendarEventToActivityStreams(EVENT, {
      id: "https://social.example/events/picnic",
    });
    expect(doc.type).toBe("Event");
    expect(doc.id).toBe("https://social.example/events/picnic");
    expect(doc.name).toBe("Summer Picnic");
    expect(doc.content).toBe("Bring a dish to share.");
    expect(doc.startTime).toBe("2026-07-04T17:00:00Z");
    expect(doc.endTime).toBe("2026-07-04T21:00:00Z");
    expect(doc.location).toEqual({
      type: "Place",
      name: "Civic Center, Room 12",
    });
    expect(doc.url).toBe("https://social.example/events/picnic");
    expect(doc.tag).toEqual([
      { type: "Hashtag", name: "community" },
      { type: "Hashtag", name: "food" },
    ]);
    expect(doc.published).toBe("2026-06-01T00:00:00Z");
    expect(doc.updated).toBe("2026-06-15T00:00:00Z");
  });

  it("attaches no @context (the wrapping activity supplies it)", () => {
    const doc = calendarEventToActivityStreams(EVENT);
    expect(doc["@context"]).toBeUndefined();
    // No id when none supplied, so the outbox publish path can assign one.
    expect(doc.id).toBeUndefined();
  });

  it("omits absent optional fields and emits arrays for multiple values", () => {
    const doc = calendarEventToActivityStreams({
      uid: "minimal",
      start: "2026-01-01",
      locations: [{ name: "Hall A" }, { name: "Hall B" }],
      links: [{ href: "https://a.example" }, { href: "https://b.example" }],
    });
    expect(doc.name).toBeUndefined();
    expect(doc.endTime).toBeUndefined();
    expect(doc.tag).toBeUndefined();
    expect(doc.location).toEqual([
      { type: "Place", name: "Hall A" },
      { type: "Place", name: "Hall B" },
    ]);
    expect(doc.url).toEqual(["https://a.example", "https://b.example"]);
  });

  it("rejects an invalid event (no uid) via assertSerializable", () => {
    expect(() =>
      calendarEventToActivityStreams({
        uid: "",
        start: "2026-01-01",
      }),
    ).toThrow(/uid/);
  });
});

describe("participationTarget", () => {
  it("reads the event IRI from `object`", () => {
    expect(
      participationTarget({
        type: "Join",
        actor: "https://remote.example/users/a",
        object: "https://social.example/events/picnic",
      }),
    ).toBe("https://social.example/events/picnic");
  });

  it("reads an embedded object's id", () => {
    expect(
      participationTarget({
        type: "Join",
        object: { id: "https://social.example/events/picnic", type: "Event" },
      }),
    ).toBe("https://social.example/events/picnic");
  });

  it("falls back to `target` when there is no `object`", () => {
    expect(
      participationTarget({
        type: "Join",
        target: "https://social.example/events/gala",
      }),
    ).toBe("https://social.example/events/gala");
  });

  it("is undefined when neither names an IRI", () => {
    expect(participationTarget({ type: "Join" })).toBeUndefined();
  });
});
