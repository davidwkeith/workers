# @dwk/calendar

## 0.1.0-beta.2

### Patch Changes

- 36a3be1: Validate the non-TEXT iCalendar fields that are emitted verbatim, closing a
  content-line injection (#306). `DURATION`, `URL`, the `TZID` parameter, and
  `REFRESH-INTERVAL` were interpolated into content lines without escaping (unlike
  TEXT values, which `escapeText` handles), so user-derived content flowing into a
  `CalendarEvent` (e.g. an `h-event`) could smuggle CR/LF and inject arbitrary
  properties into a subscriber's calendar. The serializer now rejects a `timeZone`
  that is not a well-formed IANA identifier, a malformed `DURATION`/
  `refreshInterval`, and any `URL` carrying a control character; the feed handler
  rejects a `filename` that would break the quoted `Content-Disposition` value.

## 0.1.0-beta.1

### Minor Changes

- fc4f47b: Add `@dwk/calendar` — the calendar/events interop layer (#170, epic #167). A
  cross-standard reusable lib holding the canonical, JSCalendar
  (RFC 8984)-shaped `CalendarEvent` model and the serializers from it to the
  universal calendar formats, so a single event record is importable and
  subscribable by mainstream calendar apps.

  - **Canonical model.** `CalendarEvent` uses RFC 3339 date strings (offset/`Z` →
    UTC instant, date-only → all-day, floating → optional IANA `timeZone`);
    `uid`/`start` required, duration via `end` or `duration`.
  - **iCalendar (RFC 5545).** `toICalendar(event)` and `toICalendarFeed(events)`
    emit `VEVENT`/`VCALENDAR`, hand-rolled (no `ical` dependency) and correct on
    CRLF endings, 75-octet line folding (never mid-code-point), and TEXT escaping.
    No `METHOD` is emitted, keeping `webcal://` feeds subscription-friendly;
    `DTSTAMP` is injectable for deterministic output.
  - **JSCalendar (RFC 8984).** `toJSCalendar(event)` resolves the model's date
    shapes into JSCalendar's floating-`start`/`timeZone` split and derives a
    `duration` from `end`.
  - **Optional feed handler.** `createCalendarFeed(config)` returns the standard
    `(request, env, ctx) => Promise<Response>` handler — stateless, binding-free,
    events supplied by an injected resolver — serving `text/calendar`. Fails loudly
    without a resolver.

  Pure, zero runtime dependencies, Node-tested, and deliberately free of
  IndieWeb/Solid/Fediverse assumptions: the per-standard adapters live in the
  endpoint packages and depend on this lib, never the reverse.
