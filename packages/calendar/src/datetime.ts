/**
 * Date-time conversion between the canonical model's RFC 3339 strings and the
 * compact forms iCalendar (RFC 5545 §3.3) and JSCalendar (RFC 8984) want. Pure
 * string/`Date` arithmetic — no timezone database — so it runs identically under
 * Node and `workerd`.
 *
 * A canonical value is one of three shapes, and each maps to a distinct
 * iCalendar property form:
 * - **date-only** `YYYY-MM-DD` → `VALUE=DATE` (`20200115`), an all-day event;
 * - **absolute** date-time with `Z` or a numeric offset → a UTC instant
 *   (`20200115T210000Z`), normalised so the wall clock and zone never disagree;
 * - **floating** date-time with no offset → either `TZID=…` local time when a
 *   zone is supplied, or a truly floating value otherwise.
 *
 * @packageDocumentation
 */

/** A date or date-time rendered for an iCalendar property. */
export interface ICalDateTime {
  /** The value text, e.g. `"20200115T210000Z"` or `"20200115"`. */
  readonly value: string;
  /** Property parameters to splice before the colon, e.g. `";VALUE=DATE"` or `";TZID=America/New_York"`. */
  readonly params: string;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a `Date` as a UTC iCalendar date-time, e.g. `20200115T210000Z`. */
export function formatUtc(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
  );
}

/**
 * Convert an RFC 3339 date or date-time to its iCalendar property form, honoring
 * the three shapes above. `timeZone` qualifies a floating date-time only; it is
 * ignored when the value already pins an offset (the instant is unambiguous) and
 * for date-only values (all-day events are zoneless by definition).
 *
 * Throws on an unparseable value rather than emitting a malformed property.
 */
export function toICalDate(
  value: string,
  timeZone?: string | null,
): ICalDateTime {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return { value: `${y}${m}${d}`, params: ";VALUE=DATE" };
  }

  const dt = DATE_TIME.exec(value);
  if (!dt) {
    throw new Error(`unparseable calendar date-time: ${JSON.stringify(value)}`);
  }
  const [, y, m, d, hh, mm, ss, offset] = dt;
  const secs = ss ?? "00";

  if (offset) {
    // Absolute instant: let `Date` apply the offset (it parses `Z` and numeric
    // offsets reliably) and render the canonical UTC form. The instant is
    // preserved even though the original wall-clock zone name is not.
    return { value: formatUtc(new Date(value)), params: "" };
  }

  // Floating wall clock: emit the digits verbatim. With a zone it becomes a
  // `TZID` local time; without one it stays floating (same clock everywhere).
  const local = `${y}${m}${d}T${hh}${mm}${secs}`;
  return {
    value: local,
    params: timeZone ? `;TZID=${timeZone}` : "",
  };
}

/**
 * Parse an RFC 3339 timestamp to a `Date` for properties that are always UTC
 * (`DTSTAMP`, `CREATED`, `LAST-MODIFIED`). A floating value (no offset) is read
 * as UTC, the only defensible default for a timestamp that names no zone.
 * Returns `null` for an unparseable input so the caller can simply omit the
 * property.
 */
export function toInstant(value: string): Date | null {
  if (!DATE_ONLY.test(value) && !DATE_TIME.test(value)) {
    return null;
  }
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  // Append `Z` to a floating date-time (and treat a date-only as UTC midnight)
  // so `Date` does not silently apply the host's local zone.
  const normalized = hasOffset
    ? value
    : DATE_ONLY.test(value)
      ? `${value}T00:00:00Z`
      : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}
