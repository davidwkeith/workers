# @dwk/calendar

Canonical event model + iCalendar/JSCalendar serializers.

## What this is

A cross-standard reusable lib holding the JSCalendar (RFC 8984)-shaped
`CalendarEvent` model and the serializers from it to RFC 5545 iCalendar (`.ics`)
and JSCalendar JSON, plus an optional stateless `text/calendar` feed handler for
`webcal://` subscription. The shared event record for the calendar/events epic
(#167): an `h-event`, a `VEVENT`, an AS2 `Event`, and a pod RDF resource are
serializations of one `CalendarEvent`.

## Spec

`spec/packages/calendar.md` — authoritative requirements.

## Key constraints

- **Free of IndieWeb/Solid/Fediverse assumptions** (hard cross-standard-lib
  rule). Imports no other `@dwk` package. Per-standard adapters (e.g.
  `h-event → CalendarEvent`) live in the endpoint packages and depend on this
  lib, never the reverse — `hEventToCalendarEvent` is in `@dwk/micropub`.
- **Pure, zero runtime dependencies.** Plain data in, strings/JSON out. The
  hand-rolled iCalendar emitter avoids a heavy `ical` dep (script-size budget).
- **RFC 5545 correctness:** CRLF endings, 75-octet line folding (never
  mid-code-point), TEXT escaping. No `METHOD` (subscription-friendly).
- **Dates are RFC 3339 strings.** Offset/`Z` → UTC instant; date-only →
  all-day; floating → optional IANA `timeZone`. `now`/`DTSTAMP` injectable for
  deterministic output.

## Test environment

Node (`environment: "node"`) — plain-data inputs, no Workers runtime.

```bash
pnpm test --project @dwk/calendar
```

## File layout

```
src/index.ts        # public surface
src/model.ts        # CalendarEvent canonical model + assertSerializable
src/datetime.ts     # RFC 3339 ↔ iCalendar/UTC date-time helpers
src/icalendar.ts    # toICalendar / toICalendarFeed (RFC 5545)
src/jscalendar.ts   # toJSCalendar (RFC 8984)
src/feed.ts         # createCalendarFeed stateless feed handler
src/*.test.ts       # colocated tests
```

## Dependencies

None (runtime). Pure serialization.
