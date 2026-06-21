/**
 * JSCalendar (RFC 8984) serializer: the canonical {@link CalendarEvent} out to a
 * JSCalendar `Event` JSON object. JSCalendar is the modern IETF JSON calendar
 * model and the natural JSON surface alongside the `.ics` form — both are views
 * of the same canonical record.
 *
 * JSCalendar separates a floating local `start` from its `timeZone`, so this
 * serializer resolves the canonical model's three date shapes into that split:
 * a date-only start becomes a midnight `start` with `showWithoutTime: true`; an
 * absolute (offset/`Z`) start is normalised to UTC with `timeZone: "Etc/UTC"`;
 * a floating start keeps its wall clock and the event's `timeZone`. Where the
 * canonical model gives an `end`, a positive `duration` is derived (JSCalendar's
 * native form).
 *
 * @see https://www.rfc-editor.org/rfc/rfc8984
 * @packageDocumentation
 */

import {
  type CalendarEvent,
  type EventStatus,
  assertSerializable,
} from "./model.js";
import { toInstant } from "./datetime.js";

/** A JSCalendar `Location` object (subset). */
export interface JSCalendarLocation {
  readonly "@type": "Location";
  readonly name: string;
}

/** A JSCalendar `Link` object (subset). */
export interface JSCalendarLink {
  readonly "@type": "Link";
  readonly href: string;
  readonly rel?: string;
}

/** A JSCalendar `Event` object (the subset this serializer emits). */
export interface JSCalendarEvent {
  readonly "@type": "Event";
  readonly uid: string;
  readonly title?: string;
  readonly description?: string;
  readonly start: string;
  readonly duration?: string;
  readonly timeZone?: string | null;
  readonly showWithoutTime?: boolean;
  readonly locations?: Readonly<Record<string, JSCalendarLocation>>;
  readonly keywords?: Readonly<Record<string, true>>;
  readonly links?: Readonly<Record<string, JSCalendarLink>>;
  readonly status?: EventStatus;
  readonly created?: string;
  readonly updated?: string;
  readonly sequence?: number;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Render a `Date` as a JSCalendar local date-time (no offset), from UTC fields. */
function utcLocalDateTime(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
  );
}

/** Render a `Date` as a JSCalendar UTC date-time (RFC 3339 with `Z`). */
function utcDateTime(date: Date): string {
  return `${utcLocalDateTime(date)}Z`;
}

interface ResolvedStart {
  readonly start: string;
  readonly timeZone: string | null;
  readonly showWithoutTime: boolean;
}

/** Resolve the canonical start + zone into JSCalendar's local-start/timeZone split. */
function resolveStart(
  value: string,
  timeZone: string | null | undefined,
): ResolvedStart {
  if (DATE_ONLY.test(value)) {
    return {
      start: `${value}T00:00:00`,
      timeZone: null,
      showWithoutTime: true,
    };
  }
  const m = DATE_TIME.exec(value);
  if (!m) {
    throw new Error(`unparseable calendar date-time: ${JSON.stringify(value)}`);
  }
  const [, y, mo, d, hh, mm, ss, offset] = m;
  if (offset) {
    // Absolute instant → normalise to UTC, naming the zone so the wall clock is
    // unambiguous (JSCalendar's `start` is always a floating local time). The
    // space→`T` keeps engines that reject a space separator happy.
    return {
      start: utcLocalDateTime(new Date(value.replace(" ", "T"))),
      timeZone: "Etc/UTC",
      showWithoutTime: false,
    };
  }
  return {
    start: `${y}-${mo}-${d}T${hh}:${mm}:${ss ?? "00"}`,
    timeZone: timeZone ?? null,
    showWithoutTime: false,
  };
}

/**
 * Build an ISO 8601 duration from a millisecond span, or `null` when it rounds
 * to nothing. The guard is on whole seconds, not `ms`: a sub-second span (e.g.
 * 500 ms) floors to zero, and emitting a bare `P` would be an invalid duration,
 * so it is treated as no duration (the JSCalendar default).
 */
function msToDuration(ms: number): string | null {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds <= 0) return null;
  const days = Math.floor(totalSeconds / 86400);
  let rem = totalSeconds - days * 86400;
  const hours = Math.floor(rem / 3600);
  rem -= hours * 3600;
  const minutes = Math.floor(rem / 60);
  const seconds = rem - minutes * 60;
  const time =
    `${hours ? `${hours}H` : ""}${minutes ? `${minutes}M` : ""}` +
    `${seconds ? `${seconds}S` : ""}`;
  // `totalSeconds > 0` guarantees at least one component, never a bare "P".
  return `P${days ? `${days}D` : ""}${time ? `T${time}` : ""}`;
}

/** Derive a JSCalendar `duration`, preferring an explicit one over an `end` span. */
function resolveDuration(event: CalendarEvent): string | undefined {
  if (event.duration) return event.duration;
  if (!event.end) return undefined;
  const start = toInstant(event.start);
  const end = toInstant(event.end);
  if (!start || !end) return undefined;
  return msToDuration(end.getTime() - start.getTime()) ?? undefined;
}

/** Convert an array to a JSCalendar `Id`-keyed map (`"1"`, `"2"`, …). */
function toIdMap<T, U>(
  items: readonly T[] | undefined,
  map: (item: T) => U,
): Record<string, U> | undefined {
  if (!items?.length) return undefined;
  const out: Record<string, U> = {};
  items.forEach((item, i) => {
    out[String(i + 1)] = map(item);
  });
  return out;
}

/**
 * Serialize a canonical event to a JSCalendar `Event` object. Optional fields
 * are omitted (not set to `undefined`) so the result is a clean JSON document.
 */
export function toJSCalendar(event: CalendarEvent): JSCalendarEvent {
  assertSerializable(event);
  const { start, timeZone, showWithoutTime } = resolveStart(
    event.start,
    event.timeZone,
  );
  const duration = resolveDuration(event);

  const keywords = event.keywords?.length
    ? Object.fromEntries(event.keywords.map((k) => [k, true as const]))
    : undefined;
  const locations = toIdMap(event.locations, (l) => ({
    "@type": "Location" as const,
    name: l.name,
  }));
  const links = toIdMap(event.links, (l) => ({
    "@type": "Link" as const,
    href: l.href,
    ...(l.rel !== undefined ? { rel: l.rel } : {}),
  }));

  const created = event.created ? toInstant(event.created) : null;
  const updated = event.updated ? toInstant(event.updated) : null;

  return {
    "@type": "Event",
    uid: event.uid,
    ...(event.title !== undefined ? { title: event.title } : {}),
    ...(event.description !== undefined
      ? { description: event.description }
      : {}),
    start,
    ...(duration !== undefined ? { duration } : {}),
    ...(timeZone !== null ? { timeZone } : {}),
    ...(showWithoutTime ? { showWithoutTime: true } : {}),
    ...(locations ? { locations } : {}),
    ...(keywords ? { keywords } : {}),
    ...(links ? { links } : {}),
    ...(event.status !== undefined ? { status: event.status } : {}),
    ...(created ? { created: utcDateTime(created) } : {}),
    ...(updated ? { updated: utcDateTime(updated) } : {}),
    ...(typeof event.sequence === "number" ? { sequence: event.sequence } : {}),
  };
}
