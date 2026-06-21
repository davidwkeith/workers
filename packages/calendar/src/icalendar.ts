/**
 * RFC 5545 iCalendar (`text/calendar`) serializer: the canonical
 * {@link CalendarEvent} model out to a `VEVENT`, and a set of events out to a
 * subscribable `VCALENDAR` feed. Hand-rolled (no `ical` dependency) to stay
 * inside the Worker script-size budget, and pure (plain data in, a string out)
 * so it unit-tests under Node.
 *
 * Output is spec-correct on the easy-to-get-wrong details: CRLF line endings,
 * content-line folding at 75 octets, and TEXT-value escaping (RFC 5545 §3.1,
 * §3.3.11). No `METHOD` is emitted — a feed with `METHOD:PUBLISH` is treated by
 * some clients as a one-shot import rather than a live subscription, and this
 * serializer targets `webcal://` subscription.
 *
 * @see https://www.rfc-editor.org/rfc/rfc5545
 * @packageDocumentation
 */

import { type CalendarEvent, assertSerializable } from "./model.js";
import { formatUtc, toICalDate, toInstant } from "./datetime.js";

/** Options shared by the single-event and feed serializers. */
export interface ICalendarOptions {
  /**
   * Product identifier for the `PRODID` property (RFC 5545 §3.7.3). Defaults to
   * a generic `@dwk/workers` identifier; supply your own for a real deployment.
   */
  readonly prodId?: string;
  /** Calendar display name (RFC 7986 `NAME` + legacy `X-WR-CALNAME`). */
  readonly calName?: string;
  /** Suggested client refresh cadence as an ISO 8601 duration (RFC 7986 `REFRESH-INTERVAL`). */
  readonly refreshInterval?: string;
  /**
   * Generation time stamped into every `VEVENT` as `DTSTAMP`. Defaults to "now";
   * inject a fixed `Date` for deterministic output (tests, content hashing).
   */
  readonly now?: Date;
}

const DEFAULT_PRODID = "-//dwk//@dwk/workers calendar//EN";

/** Escape a TEXT value per RFC 5545 §3.3.11 (backslash first, then the rest). */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** UTF-8 byte length of a single code point, for octet-accurate line folding. */
function byteLength(codePoint: string): number {
  const cp = codePoint.codePointAt(0) ?? 0;
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

/**
 * Fold a content line to <=75 octets per RFC 5545 §3.1, breaking only between
 * code points (never mid-character) and prefixing each continuation with a
 * single space. Iterating with `for…of` walks whole code points, so an
 * astral-plane character stays intact.
 */
function foldLine(line: string): string {
  const LIMIT = 75;
  const segments: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of line) {
    const bytes = byteLength(ch);
    if (currentBytes + bytes > LIMIT) {
      segments.push(current);
      current = ` ${ch}`;
      currentBytes = 1 + bytes;
    } else {
      current += ch;
      currentBytes += bytes;
    }
  }
  segments.push(current);
  return segments.join("\r\n");
}

/** Append `NAME:value` (value escaped as TEXT) when the value is non-empty. */
function pushText(
  lines: string[],
  name: string,
  value: string | undefined,
): void {
  if (value) lines.push(`${name}:${escapeText(value)}`);
}

/** Render the start/end (or duration) lines for a `VEVENT`. */
function pushTiming(lines: string[], event: CalendarEvent): void {
  const start = toICalDate(event.start, event.timeZone);
  lines.push(`DTSTART${start.params}:${start.value}`);

  if (event.duration) {
    lines.push(`DURATION:${event.duration}`);
  } else if (event.end) {
    const end = toICalDate(event.end, event.timeZone);
    lines.push(`DTEND${end.params}:${end.value}`);
  }
}

/**
 * Serialize one event to its `VEVENT` content lines (unfolded). Exposed for the
 * feed builder; most callers want {@link toICalendar} or {@link toICalendarFeed}.
 */
export function toVEventLines(event: CalendarEvent, dtstamp: Date): string[] {
  assertSerializable(event);
  const lines: string[] = ["BEGIN:VEVENT"];

  lines.push(`UID:${escapeText(event.uid)}`);
  lines.push(`DTSTAMP:${formatUtc(dtstamp)}`);
  pushTiming(lines, event);
  pushText(lines, "SUMMARY", event.title);
  pushText(lines, "DESCRIPTION", event.description);

  if (event.locations?.length) {
    pushText(lines, "LOCATION", event.locations.map((l) => l.name).join(", "));
  }
  if (event.keywords?.length) {
    // CATEGORIES is a comma-separated list; escape each value so a value's own
    // comma does not read as a separator.
    lines.push(`CATEGORIES:${event.keywords.map(escapeText).join(",")}`);
  }
  // URL is a URI value (not TEXT), so it is emitted unescaped.
  const url = event.links?.[0]?.href;
  if (url) lines.push(`URL:${url}`);

  if (event.status) lines.push(`STATUS:${event.status.toUpperCase()}`);
  if (event.created) {
    const created = toInstant(event.created);
    if (created) lines.push(`CREATED:${formatUtc(created)}`);
  }
  if (event.updated) {
    const updated = toInstant(event.updated);
    if (updated) lines.push(`LAST-MODIFIED:${formatUtc(updated)}`);
  }
  if (typeof event.sequence === "number") {
    lines.push(`SEQUENCE:${event.sequence}`);
  }

  lines.push("END:VEVENT");
  return lines;
}

/** Wrap rendered `VEVENT` lines in a `VCALENDAR`, fold, and join with CRLF. */
function wrapCalendar(eventLines: string[], options: ICalendarOptions): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${escapeText(options.prodId ?? DEFAULT_PRODID)}`,
    "CALSCALE:GREGORIAN",
  ];
  if (options.calName) {
    pushText(lines, "NAME", options.calName);
    pushText(lines, "X-WR-CALNAME", options.calName);
  }
  if (options.refreshInterval) {
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${options.refreshInterval}`);
  }
  lines.push(...eventLines, "END:VCALENDAR");
  // RFC 5545 §3.4: the iCalendar object ends with a trailing CRLF.
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/** Serialize a single event to a complete `VCALENDAR` document. */
export function toICalendar(
  event: CalendarEvent,
  options: ICalendarOptions = {},
): string {
  return wrapCalendar(toVEventLines(event, options.now ?? new Date()), options);
}

/**
 * Serialize many events to one subscribable `VCALENDAR` feed — the body a
 * `webcal://` subscription or an `.ics` download serves. A shared `DTSTAMP` is
 * stamped across all events so a regenerated feed with unchanged events is byte
 * identical when `now` is held fixed.
 */
export function toICalendarFeed(
  events: readonly CalendarEvent[],
  options: ICalendarOptions = {},
): string {
  const dtstamp = options.now ?? new Date();
  const eventLines = events.flatMap((event) => toVEventLines(event, dtstamp));
  return wrapCalendar(eventLines, options);
}
