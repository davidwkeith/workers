/**
 * The canonical, protocol-agnostic event model the calendar serializers read.
 *
 * It is **JSCalendar-shaped** (RFC 8984): the same record serializes outward to
 * an RFC 5545 `VEVENT` ({@link "./icalendar"}), to JSCalendar JSON
 * ({@link "./jscalendar"}), and — via per-standard adapters living in the
 * endpoint packages, never here — to an IndieWeb `h-event`, an ActivityStreams
 * `Event`, or a pod RDF resource. Keeping this model free of any one standard's
 * assumptions is what lets the four serializations be three views of one record;
 * it is the reason this lib carries no IndieWeb/Solid/Fediverse imports.
 *
 * Dates are RFC 3339 strings, not `Date`s, so a value round-trips byte-for-byte
 * without a timezone database. A date-only `start`/`end` (`YYYY-MM-DD`) is an
 * all-day event; a date-time may be UTC (`…Z`), carry a numeric offset, or be a
 * floating wall-clock time qualified by {@link CalendarEvent.timeZone}.
 *
 * @see https://www.rfc-editor.org/rfc/rfc8984 (JSCalendar)
 * @packageDocumentation
 */

/** A place an event happens. Mirrors the JSCalendar `Location` object (subset). */
export interface EventLocation {
  /** Human-readable location name, e.g. `"Civic Center, Room 12"`. */
  readonly name: string;
}

/** A link associated with an event. Mirrors the JSCalendar `Link` object (subset). */
export interface EventLink {
  /** The link target URI. */
  readonly href: string;
  /** Optional link relation (e.g. `"alternate"`). */
  readonly rel?: string;
}

/** Scheduling status of an event. Maps to iCalendar `STATUS` and JSCalendar `status`. */
export type EventStatus = "confirmed" | "cancelled" | "tentative";

/**
 * One calendar event in the canonical model.
 *
 * `uid` and `start` are the only required fields — every serializer rejects an
 * event missing either, because an `.ics` `VEVENT` with no `UID`/`DTSTART` is
 * invalid and a calendar without stable identity cannot be re-subscribed.
 *
 * Duration is expressed by **either** {@link end} **or** {@link duration}, never
 * both; `end` is the iCalendar/`h-event`-friendly form and `duration` the
 * JSCalendar-native one. When both are absent the event has no defined end.
 */
export interface CalendarEvent {
  /** Globally unique, stable identifier (iCalendar `UID`, JSCalendar `uid`). */
  readonly uid: string;
  /** Event title (iCalendar `SUMMARY`, JSCalendar `title`). */
  readonly title?: string;
  /** Longer description (iCalendar `DESCRIPTION`, JSCalendar `description`). */
  readonly description?: string;
  /** Start, as an RFC 3339 date (`YYYY-MM-DD`, all-day) or date-time. */
  readonly start: string;
  /** End, in the same form as {@link start}. Mutually exclusive with {@link duration}. */
  readonly end?: string;
  /** ISO 8601 duration (e.g. `"PT1H"`). Mutually exclusive with {@link end}. */
  readonly duration?: string;
  /**
   * IANA time zone name (e.g. `"America/Los_Angeles"`) qualifying a floating
   * wall-clock {@link start}/{@link end}. Ignored when the date-time already
   * carries a `Z` or numeric offset. `null` means explicitly floating.
   */
  readonly timeZone?: string | null;
  /** Where the event happens. */
  readonly locations?: readonly EventLocation[];
  /** Free-text tags/categories (iCalendar `CATEGORIES`, JSCalendar `keywords`). */
  readonly keywords?: readonly string[];
  /** Related links (iCalendar `URL` uses the first; JSCalendar keeps all). */
  readonly links?: readonly EventLink[];
  /** Scheduling status. */
  readonly status?: EventStatus;
  /** Creation timestamp, RFC 3339 (iCalendar `CREATED`, JSCalendar `created`). */
  readonly created?: string;
  /** Last-modified timestamp, RFC 3339 (iCalendar `LAST-MODIFIED`, `updated`). */
  readonly updated?: string;
  /** Revision counter (iCalendar `SEQUENCE`, JSCalendar `sequence`). */
  readonly sequence?: number;
}

/**
 * Assert an event carries the identity and start every serializer requires,
 * narrowing nothing but throwing a single clear error instead of emitting an
 * invalid `VEVENT`/JSCalendar object. Called by each serializer entry point so
 * the failure is loud and uniform regardless of output format.
 */
export function assertSerializable(event: CalendarEvent): void {
  if (!event.uid) {
    throw new Error("calendar event requires a non-empty `uid`");
  }
  if (!event.start) {
    throw new Error(`calendar event ${event.uid} requires a "start"`);
  }
}
