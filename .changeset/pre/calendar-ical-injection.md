---
"@dwk/calendar": patch
---

Validate the non-TEXT iCalendar fields that are emitted verbatim, closing a
content-line injection (#306). `DURATION`, `URL`, the `TZID` parameter, and
`REFRESH-INTERVAL` were interpolated into content lines without escaping (unlike
TEXT values, which `escapeText` handles), so user-derived content flowing into a
`CalendarEvent` (e.g. an `h-event`) could smuggle CR/LF and inject arbitrary
properties into a subscriber's calendar. The serializer now rejects a `timeZone`
that is not a well-formed IANA identifier, a malformed `DURATION`/
`refreshInterval`, and any `URL` carrying a control character; the feed handler
rejects a `filename` that would break the quoted `Content-Disposition` value.
