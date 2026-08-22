---
"@dwk/micropub": minor
---

Add `hEventToCalendarEvent(mf2)` — the IndieWeb-specific adapter from a stored
`h-event` microformats2 object to the canonical `CalendarEvent` model in the new
[`@dwk/calendar`](https://github.com/davidwkeith/workers/tree/main/packages/calendar)
lib, which then serializes to `.ics`/JSCalendar. It maps `uid` (falling back to
`url`) → identity, `name` → title, `summary`/`content` → description,
`dt-start`/`dt-end` → start/end, `location` → locations, `category` → keywords,
and `published`/`updated` → timestamps. The adapter lives here, not in
`@dwk/calendar`, because that cross-standard lib must stay free of IndieWeb
assumptions. Pure and unit-tested for the `h-event → CalendarEvent → .ics`
round-trip. Part of the calendar/events work (#170, epic #167).
