---
"@dwk/solid-pod": minor
---

Add `calendarEventToQuads(event, subjectIri)` / `quadsToCalendarEvent(quads,
subjectIri)` — the Solid-specific adapter between the canonical `CalendarEvent`
model in [`@dwk/calendar`](https://github.com/davidwkeith/workers/tree/main/packages/calendar)
and RDF, so calendar events live as ordinary WAC-gated LDP resources in a pod.
[schema.org](https://schema.org/Event) is the canonical vocabulary
(`schema:Event` + `startDate`/`endDate`/`location`/`keywords`/`eventStatus`/…),
JSON-LD-native and what Solid clients expect; the adapter emits and reads it via
the flat `StoredQuad` shape the DO quad store and `@dwk/rdf` already use, so a
client serializes with `@dwk/rdf` and PUTs Turtle/JSON-LD through the existing
LDP surface, then reads it back into the same record. `uid` round-trips as
`schema:identifier`; `start`/`end` carry `xsd:date`/`xsd:dateTime`. The same
event is thus a view shared with the `.ics` `VEVENT`, JSCalendar, `h-event`, and
AS2 `Event` serializations. The adapter lives here, not in the cross-standard
`@dwk/calendar` lib, which must stay free of Solid/RDF assumptions. Part of the
calendar/events work (#172, epic #167).
