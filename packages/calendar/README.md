# @dwk/calendar

Canonical event model + calendar serializers: a JSCalendar (RFC 8984)-shaped
`CalendarEvent`, an RFC 5545 iCalendar (`.ics`) emitter, a JSCalendar JSON
serializer, and an optional stateless `text/calendar` feed handler for
`webcal://` subscription.

Part of [`@dwk/workers`](https://github.com/davidwkeith/workers) — composable
[Cloudflare Workers](https://developers.cloudflare.com/workers/) packages
implementing open web standards on your own domain. It is a **cross-standard
reusable lib**: pure, zero-dependency, Workers-runtime-free, and deliberately
free of any one standard's assumptions.

## Install

```sh
npm install @dwk/calendar
```

## Why it exists

One event record, several serializations. The
[calendar/events epic](https://github.com/davidwkeith/workers/issues/167) wants
an IndieWeb `h-event`, an iCalendar `VEVENT`, an ActivityStreams `Event`, and a
pod RDF resource to be views of the **same** record. `@dwk/calendar` holds that
shared `CalendarEvent` model and the two format-pure serializers; the
vocabulary-specific adapters (e.g. `h-event → CalendarEvent`) live in the
endpoint packages that own each vocabulary and depend on this lib.

## Usage

### Serialize an event to iCalendar

```ts
import { toICalendar, type CalendarEvent } from "@dwk/calendar";

const event: CalendarEvent = {
  uid: "park-cleanup-1@example.com",
  title: "Park Cleanup",
  start: "2026-07-01T18:00:00-07:00",
  end: "2026-07-01T20:00:00-07:00",
  locations: [{ name: "Civic Center" }],
  keywords: ["volunteering"],
};

const ics = toICalendar(event); // a complete VCALENDAR string
```

### Serve a subscribable feed

```ts
import { createCalendarFeed } from "@dwk/calendar";

// Stateless and binding-free: you inject the events resolver.
const handler = createCalendarFeed({
  calName: "Community Events",
  prodId: "-//Example//Events//EN",
  events: async () => loadUpcomingEvents(), // your store
});

// handler(request) → Response (text/calendar) — mount it in your Worker.
```

### JSCalendar JSON

```ts
import { toJSCalendar } from "@dwk/calendar";

const json = toJSCalendar(event); // an RFC 8984 Event object
```

## API

| Export | Purpose |
| --- | --- |
| `CalendarEvent` (type) | The canonical, JSCalendar-shaped event model. |
| `toICalendar(event, opts?)` | One event → a `VCALENDAR` string. |
| `toICalendarFeed(events, opts?)` | Many events → one subscribable feed. |
| `toJSCalendar(event)` | Event → a JSCalendar (RFC 8984) JSON object. |
| `createCalendarFeed(config)` | Stateless `text/calendar` feed handler. |
| `toICalDate`, `toInstant`, `formatUtc` | Date-time helpers. |

## Notes

- Output is RFC 5545-correct on CRLF endings, 75-octet line folding, and TEXT
  escaping. No `METHOD` is emitted, keeping feeds subscription-friendly.
- Dates are RFC 3339 strings; offset/`Z` times normalise to UTC instants,
  date-only values are all-day, and floating times can be qualified with an IANA
  `timeZone`.
- MVP is export-only; `.ics` import is a planned follow-up.

## License

ISC
