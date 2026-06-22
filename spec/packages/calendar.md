# `@dwk/calendar`

| | |
|---|---|
| **Type** | cross-standard reusable lib |
| **Ships a DO?** | no |
| **Standard** | [iCalendar (RFC 5545)](https://www.rfc-editor.org/rfc/rfc5545) + [RFC 7986](https://www.rfc-editor.org/rfc/rfc7986); [JSCalendar (RFC 8984)](https://www.rfc-editor.org/rfc/rfc8984) |
| **Status** | implemented (unreleased) — tracked in [#170](https://github.com/davidwkeith/workers/issues/170) (epic [#167](https://github.com/davidwkeith/workers/issues/167)) |

The calendar/events interop layer: a **canonical event model** and the
serializers that turn it into the universal calendar formats so events authored
in the cohort are importable and subscribable by mainstream calendar apps
(Apple/Google/Outlook) via `webcal://`.

## Role in the events epic

Issue [#167](https://github.com/davidwkeith/workers/issues/167) wants one event
record to have four serializations — an IndieWeb `h-event`, an iCalendar
`VEVENT`, an ActivityStreams `Event`, and a pod RDF resource. `@dwk/calendar`
holds the **shared canonical model** those serializations agree on
(`CalendarEvent`), shaped after JSCalendar (RFC 8984), plus the two format-pure
serializers (`.ics` and JSCalendar JSON). The remaining layers serialize from
the same model.

## Cross-standard purity (hard constraint)

Per [`CLAUDE.md`](../../CLAUDE.md) and
[composition-contract.md](../composition-contract.md), a cross-standard lib MUST
stay **free of IndieWeb/Solid/Fediverse assumptions** so future `@dwk` standards
adopt it unchanged. Therefore:

- `@dwk/calendar` contains **only** the canonical model and the protocol-neutral
  iCalendar/JSCalendar serializers. It imports no other `@dwk` package.
- The per-standard **adapters** that read a vocabulary into `CalendarEvent` live
  in the endpoint package that owns that vocabulary, depending on
  `@dwk/calendar` (never the reverse):
  - `h-event → CalendarEvent` is `hEventToCalendarEvent` in
    [`@dwk/micropub`](micropub.md).
  - (planned) ActivityStreams `Event` ↔ `CalendarEvent` in
    [`@dwk/activitypub`](activitypub.md) ([#171](https://github.com/davidwkeith/workers/issues/171)).
  - `schema.org Event ↔ CalendarEvent` is `calendarEventToQuads` /
    `quadsToCalendarEvent` in [`@dwk/solid-pod`](solid-pod.md)
    ([#172](https://github.com/davidwkeith/workers/issues/172)).

## Functional requirements

### Canonical model — `CalendarEvent`

JSCalendar-shaped, with RFC 3339 date **strings** (not `Date`s) so a value
round-trips without a timezone database. `uid` and `start` are required; every
serializer rejects an event missing either. A date-only `start`/`end`
(`YYYY-MM-DD`) is an all-day event; a date-time may be UTC (`…Z`), carry a
numeric offset, or be a floating wall-clock time qualified by `timeZone`.
Duration is expressed by **either** `end` (iCalendar/`h-event`-friendly) **or**
`duration` (JSCalendar-native), never both.

### iCalendar serializer (RFC 5545)

- `toICalendar(event, options?)` → a single-event `VCALENDAR`.
- `toICalendarFeed(events, options?)` → a subscribable multi-event feed (the
  body a `webcal://` subscription or an `.ics` download serves).
- Hand-rolled (no `ical` dependency) to protect the script-size budget, and
  correct on the easy-to-botch details: **CRLF** line endings, content-line
  **folding at 75 octets** (never mid-code-point), and TEXT-value **escaping**
  (`\` `;` `,` newline). **No `METHOD`** is emitted — `METHOD:PUBLISH` makes some
  clients treat a feed as a one-shot import rather than a live subscription.
- The three date shapes map to the three iCalendar property forms: date-only →
  `VALUE=DATE`; offset/`Z` → a normalised UTC instant (`…Z`); floating →
  `TZID=…` local time when a zone is supplied, else a floating value. Generation
  time (`DTSTAMP`) is injectable for deterministic, content-addressable output.

### JSCalendar serializer (RFC 8984)

- `toJSCalendar(event)` → a JSCalendar `Event` JSON object. Resolves the model's
  three date shapes into JSCalendar's floating-`start`-plus-`timeZone` split
  (date-only → `showWithoutTime`; offset → UTC with `timeZone: "Etc/UTC"`;
  floating → wall clock + the event's `timeZone`) and derives a positive
  `duration` from `end` where the model gives one. Arrays become JSCalendar
  `Id`-keyed maps. (jCal, RFC 7265, is a possible future surface.)

### Feed handler (optional serving seam)

- `createCalendarFeed(config)` returns the standard
  `(request, env, ctx) => Promise<Response>` handler, mountable under a path
  prefix, serving `GET`/`HEAD` as `text/calendar; charset=utf-8` with
  subscription-friendly headers. It is **stateless and binding-free**: events
  come from a config-injected `events(request)` resolver the host wires to its
  own store, never from the global environment, so the lib stays pure and the
  handler unit-tests under Node. Per the composition contract it **fails loudly**
  at construction when no resolver is supplied. A host that only needs the bytes
  can call `toICalendarFeed` directly.

## Bindings (declared `Env` fragment)

None. The lib is pure; the optional feed handler is stateless and resolver-fed.

## Config

`ICalendarOptions` / `CalendarFeedConfig`: `prodId`, `calName`,
`refreshInterval` (RFC 7986), the `now` clock, and (for the handler) the
`events` resolver, `filename`, and `cacheControl`. All injected — nothing is
read from the global environment.

## Non-functional fit

- **Test environment:** Node (`environment: "node"`); plain-data inputs, no
  Workers runtime needed — matches the pure-lib split in
  [`CLAUDE.md`](../../CLAUDE.md).
- **Script-size budget:** zero runtime dependencies; a minimal hand-rolled
  emitter rather than a heavy ical library, per
  [non-functional-requirements.md](../non-functional-requirements.md).

## Scope

MVP is **export-only** (canonical model → `.ics`/JSCalendar). iCalendar **import**
(`.ics` → `CalendarEvent`) and a `VTIMEZONE`-emitting mode for named-zone
floating times are deferred follow-ups; today an offset-bearing time is
preserved as its UTC instant.
