/**
 * `@dwk/calendar` — canonical event model + calendar serializers.
 *
 * A **cross-standard reusable lib**: it holds the JSCalendar (RFC 8984)-shaped
 * canonical {@link CalendarEvent} model and serializers from it to RFC 5545
 * iCalendar (`.ics`) and to JSCalendar JSON, plus an optional stateless
 * `text/calendar` feed handler for `webcal://` subscription. One record, several
 * serializations — so an `h-event`, a `VEVENT`, an ActivityStreams `Event`, and
 * a pod RDF resource are views of the same event.
 *
 * It is deliberately **free of IndieWeb/Solid/Fediverse assumptions** (the hard
 * cross-standard-lib rule): the per-standard adapters — e.g. `h-event →
 * CalendarEvent` — live in the endpoint packages that own that vocabulary
 * (`@dwk/micropub`, `@dwk/activitypub`, `@dwk/solid-pod`), which depend on this
 * lib, never the reverse. Pure (plain data in, strings/JSON out) and
 * Workers-runtime-free, so it unit-tests under Node.
 *
 * @see spec/packages/calendar.md
 * @packageDocumentation
 */

export {
  type CalendarEvent,
  type EventLocation,
  type EventLink,
  type EventStatus,
  assertSerializable,
} from "./model.js";

export {
  type ICalDateTime,
  toICalDate,
  toInstant,
  formatUtc,
} from "./datetime.js";

export {
  type ICalendarOptions,
  toICalendar,
  toICalendarFeed,
  toVEventLines,
} from "./icalendar.js";

export {
  type JSCalendarEvent,
  type JSCalendarLocation,
  type JSCalendarLink,
  toJSCalendar,
} from "./jscalendar.js";

export {
  type CalendarFeedConfig,
  type CalendarFeedHandler,
  createCalendarFeed,
} from "./feed.js";
