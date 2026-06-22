/**
 * schema.org RDF ↔ canonical {@link CalendarEvent} adapter for pod-stored events.
 *
 * This is the Solid-specific seam the cross-standard `@dwk/calendar` lib
 * deliberately does not contain (it must stay free of Solid/RDF assumptions), the
 * sibling of `@dwk/micropub`'s `hEventToCalendarEvent` and `@dwk/activitypub`'s
 * ActivityStreams adapter. The vocabulary knowledge — which RDF predicates carry
 * an event's title, start, location, … — lives here, so an event stored as RDF in
 * a pod is the *same* {@link CalendarEvent} record that serializes to an `.ics`
 * `VEVENT`, a JSCalendar object, an `h-event`, and an AS2 `Event`.
 *
 * **Vocabulary.** [schema.org](https://schema.org/Event) is the canonical
 * vocabulary (`schema:Event` + `startDate`/`endDate`/`location`/…): it is
 * JSON-LD-native, ubiquitous in structured-data tooling, and the shape Solid
 * clients expect. The W3C iCal RDF vocabulary is the documented alternative the
 * issue mentions; this adapter emits and reads schema.org only, keeping the
 * stored graph small and the round-trip unambiguous.
 *
 * **Storage path.** The adapter speaks the flat {@link StoredQuad} shape `@dwk/rdf`
 * and the DO quad store use, so a caller serializes the result with
 * `@dwk/rdf` (`storedToQuad` → `serialize`) to PUT Turtle/JSON-LD through the
 * existing LDP surface, and reads it back by parsing the resource and calling
 * {@link quadsToCalendarEvent}. No new storage or authz path: an event resource is
 * an ordinary WAC-gated LDP RDF resource.
 *
 * Pure: plain {@link CalendarEvent} / quads in and out, no Workers runtime.
 *
 * @see https://schema.org/Event
 * @see https://www.w3.org/TR/rdf-schema/
 */

import { assertSerializable, type CalendarEvent } from "@dwk/calendar";
import type { StoredQuad, StoredTerm } from "@dwk/rdf";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SCHEMA = "http://schema.org/";
const XSD = "http://www.w3.org/2001/XMLSchema#";

const XSD_STRING = `${XSD}string`;
const XSD_DATE = `${XSD}date`;
const XSD_DATE_TIME = `${XSD}dateTime`;
const XSD_DURATION = `${XSD}duration`;

const SCHEMA_EVENT = `${SCHEMA}Event`;
const SCHEMA_IDENTIFIER = `${SCHEMA}identifier`;
const SCHEMA_NAME = `${SCHEMA}name`;
const SCHEMA_DESCRIPTION = `${SCHEMA}description`;
const SCHEMA_START_DATE = `${SCHEMA}startDate`;
const SCHEMA_END_DATE = `${SCHEMA}endDate`;
const SCHEMA_DURATION = `${SCHEMA}duration`;
const SCHEMA_LOCATION = `${SCHEMA}location`;
const SCHEMA_KEYWORDS = `${SCHEMA}keywords`;
const SCHEMA_URL = `${SCHEMA}url`;
const SCHEMA_EVENT_STATUS = `${SCHEMA}eventStatus`;
const SCHEMA_DATE_CREATED = `${SCHEMA}dateCreated`;
const SCHEMA_DATE_MODIFIED = `${SCHEMA}dateModified`;

/**
 * Canonical {@link CalendarEvent.status} ↔ schema.org `EventStatusType`. Only the
 * two states schema.org names map cleanly; `"tentative"` has no schema.org
 * equivalent and is omitted on write (and so absent on read) — a documented,
 * intentional gap rather than an invented predicate.
 */
const STATUS_TO_SCHEMA = {
  confirmed: `${SCHEMA}EventScheduled`,
  cancelled: `${SCHEMA}EventCancelled`,
  tentative: null,
} as const satisfies Record<CalendarEvent["status"] & string, string | null>;

const SCHEMA_TO_STATUS: Record<string, CalendarEvent["status"]> = {
  [`${SCHEMA}EventScheduled`]: "confirmed",
  [`${SCHEMA}EventCancelled`]: "cancelled",
};

const DEFAULT_GRAPH: StoredTerm = { termType: "DefaultGraph", value: "" };

function namedNode(value: string): StoredTerm {
  return { termType: "NamedNode", value };
}

function literal(value: string, datatype = XSD_STRING): StoredTerm {
  return { termType: "Literal", value, datatype };
}

/** A date-only RFC 3339 value (`YYYY-MM-DD`, all-day) vs. a full date-time. */
function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** An RFC 3339 start/end as the matching `xsd:date` / `xsd:dateTime` literal. */
function dateLiteral(value: string): StoredTerm {
  return literal(value, isDateOnly(value) ? XSD_DATE : XSD_DATE_TIME);
}

/**
 * Render a {@link CalendarEvent} as schema.org RDF triples about `subjectIri`
 * (the LDP resource URL the event is stored at). The event is validated with the
 * same {@link assertSerializable} guard every `@dwk/calendar` serializer uses, so
 * an event missing `uid`/`start` or with an `end` before `start` fails loudly
 * here rather than producing a graph a client silently mishandles.
 *
 * `uid` is always emitted as `schema:identifier` so identity round-trips
 * independently of the subject IRI. `start`/`end`/`created`/`updated` carry their
 * RFC 3339 form with the matching `xsd:date`/`xsd:dateTime` datatype; `locations`
 * and `keywords` repeat as `schema:location`/`schema:keywords` text; `links`
 * become `schema:url` named nodes (a link's `rel` is not represented). A floating
 * `timeZone` has no schema.org projection and is not emitted.
 */
export function calendarEventToQuads(
  event: CalendarEvent,
  subjectIri: string,
): StoredQuad[] {
  assertSerializable(event);

  const subject = namedNode(subjectIri);
  const quads: StoredQuad[] = [];
  const add = (predicate: string, object: StoredTerm): void => {
    quads.push({
      subject,
      predicate: namedNode(predicate),
      object,
      graph: DEFAULT_GRAPH,
    });
  };

  add(RDF_TYPE, namedNode(SCHEMA_EVENT));
  add(SCHEMA_IDENTIFIER, literal(event.uid));
  if (event.title !== undefined) add(SCHEMA_NAME, literal(event.title));
  if (event.description !== undefined) {
    add(SCHEMA_DESCRIPTION, literal(event.description));
  }
  add(SCHEMA_START_DATE, dateLiteral(event.start));
  if (event.end !== undefined) add(SCHEMA_END_DATE, dateLiteral(event.end));
  if (event.duration !== undefined) {
    add(SCHEMA_DURATION, literal(event.duration, XSD_DURATION));
  }
  for (const location of event.locations ?? []) {
    add(SCHEMA_LOCATION, literal(location.name));
  }
  for (const keyword of event.keywords ?? []) {
    add(SCHEMA_KEYWORDS, literal(keyword));
  }
  for (const link of event.links ?? []) {
    add(SCHEMA_URL, namedNode(link.href));
  }
  if (event.status !== undefined) {
    const statusIri = STATUS_TO_SCHEMA[event.status];
    if (statusIri !== null) add(SCHEMA_EVENT_STATUS, namedNode(statusIri));
  }
  if (event.created !== undefined) {
    add(SCHEMA_DATE_CREATED, dateLiteral(event.created));
  }
  if (event.updated !== undefined) {
    add(SCHEMA_DATE_MODIFIED, dateLiteral(event.updated));
  }
  return quads;
}

/**
 * Read the schema.org event described at `subjectIri` back into a
 * {@link CalendarEvent}, the inverse of {@link calendarEventToQuads}.
 *
 * Only triples whose subject is `subjectIri` are considered, so an event resource
 * carrying unrelated triples (or several subjects) is read unambiguously. `uid`
 * comes from `schema:identifier`, falling back to `subjectIri` when an
 * externally-authored resource omits it — a pod resource's own URL is a stable
 * identity. `end` takes precedence over `duration` when a graph carries both, to
 * honor the model's mutual exclusion. The result is validated with
 * {@link assertSerializable}, so a graph with no usable `startDate` is rejected.
 */
export function quadsToCalendarEvent(
  quads: readonly StoredQuad[],
  subjectIri: string,
): CalendarEvent {
  const objectsFor = (predicate: string, termType: StoredTerm["termType"]) =>
    quads
      .filter(
        (q) =>
          q.subject.value === subjectIri &&
          q.predicate.value === predicate &&
          q.object.termType === termType,
      )
      .map((q) => q.object.value);
  const firstLiteral = (predicate: string): string | undefined =>
    objectsFor(predicate, "Literal")[0];

  const start = firstLiteral(SCHEMA_START_DATE);
  if (start === undefined) {
    throw new Error(
      `cannot convert RDF at ${subjectIri} to a calendar event: no schema:startDate`,
    );
  }

  const uid = firstLiteral(SCHEMA_IDENTIFIER) ?? subjectIri;
  const title = firstLiteral(SCHEMA_NAME);
  const description = firstLiteral(SCHEMA_DESCRIPTION);
  const end = firstLiteral(SCHEMA_END_DATE);
  const duration =
    end === undefined ? firstLiteral(SCHEMA_DURATION) : undefined;
  const created = firstLiteral(SCHEMA_DATE_CREATED);
  const updated = firstLiteral(SCHEMA_DATE_MODIFIED);
  const locations = objectsFor(SCHEMA_LOCATION, "Literal").map((name) => ({
    name,
  }));
  const keywords = objectsFor(SCHEMA_KEYWORDS, "Literal");
  const links = objectsFor(SCHEMA_URL, "NamedNode").map((href) => ({ href }));
  const statusIri = objectsFor(SCHEMA_EVENT_STATUS, "NamedNode")[0];
  const status =
    statusIri !== undefined ? SCHEMA_TO_STATUS[statusIri] : undefined;

  const event: CalendarEvent = {
    uid,
    start,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(locations.length ? { locations } : {}),
    ...(keywords.length ? { keywords } : {}),
    ...(links.length ? { links } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(created !== undefined ? { created } : {}),
    ...(updated !== undefined ? { updated } : {}),
  };
  assertSerializable(event);
  return event;
}
