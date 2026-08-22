---
"@dwk/micropub": minor
---

Support the Micropub event post type (`h=event`). Events are created and stored
like any other post (their `name`/`start`/`end`/`location`/`category` properties
round-trip through `q=source`), and a new pure `renderHEvent` helper serializes a
stored event's microformats2 to canonical `h-event` markup (`p-name`,
`dt-start`/`dt-end`, `p-location`, `p-category`, `e-content`, `u-url`) for
publishing. Also exports `H_EVENT` and `isEvent`. Part of the calendar/events
work (#168).
