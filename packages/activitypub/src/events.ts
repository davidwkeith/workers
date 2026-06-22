/**
 * Calendar-event ↔ ActivityStreams adapter for `@dwk/activitypub`.
 *
 * The Fediverse layer of the calendar/events epic (#167 / #171): it serializes
 * the canonical {@link CalendarEvent} from `@dwk/calendar` to an ActivityStreams
 * 2.0 `Event` object for the outbox, and reads inbound `Join`/`Leave` activities
 * — the ActivityPub mirror of an Indie RSVP — back to the event they target. An
 * `h-event`, a `VEVENT`, and this AS2 `Event` are three serializations of one
 * record (see `@dwk/calendar`).
 *
 * The `CalendarEvent → AS2 Event` adapter lives **here**, in the endpoint that
 * owns the ActivityPub vocabulary, never in the cross-standard `@dwk/calendar`
 * lib (the hard cross-standard-lib rule). Pure data: plain values in, plain JSON
 * out, so it unit-tests without a Workers runtime or any binding.
 */

import { assertSerializable, type CalendarEvent } from "@dwk/calendar";

import { objectId, type ActivityObject, type JsonValue } from "./as2.js";

/** Options for {@link calendarEventToActivityStreams}. */
export interface ActivityStreamsEventOptions {
  /**
   * The canonical IRI to publish the `Event` under (its AS2 `id`). When omitted,
   * the object is emitted without an `id` so the outbox publish path can assign
   * one — but a federated event SHOULD carry a stable IRI so peers can dedup and
   * address `Join`/`Leave` at it.
   */
  readonly id?: string;
}

/**
 * Serialize a canonical {@link CalendarEvent} to an ActivityStreams 2.0 `Event`
 * object (the compact JSON shape the fediverse speaks, matching Mobilizon /
 * Gancio). Core properties only: `name`, `content`, `startTime`/`endTime`,
 * `location` (as `Place`), `url`, `tag` (as `Hashtag`), and the
 * `published`/`updated` timestamps.
 *
 * No `@context` is attached: the object is meant to be wrapped in a `Create` (or
 * served beneath the actor document), and the wrapping activity supplies the
 * context — exactly as a `Note` is published. The event is validated with
 * {@link assertSerializable} first, so a malformed event (no `uid`/`start`, an
 * `end` before `start`) fails loudly here rather than emitting a broken object.
 */
export function calendarEventToActivityStreams(
  event: CalendarEvent,
  options: ActivityStreamsEventOptions = {},
): Record<string, JsonValue> {
  assertSerializable(event);

  const doc: Record<string, JsonValue> = {
    type: "Event",
    startTime: event.start,
  };
  if (options.id !== undefined) doc.id = options.id;
  if (event.title !== undefined) doc.name = event.title;
  if (event.description !== undefined) doc.content = event.description;
  if (event.end !== undefined) doc.endTime = event.end;

  const locations = event.locations ?? [];
  if (locations.length === 1) {
    doc.location = { type: "Place", name: locations[0]!.name };
  } else if (locations.length > 1) {
    doc.location = locations.map((l) => ({ type: "Place", name: l.name }));
  }

  const links = event.links ?? [];
  if (links.length === 1) {
    doc.url = links[0]!.href;
  } else if (links.length > 1) {
    doc.url = links.map((l) => l.href);
  }

  const keywords = event.keywords ?? [];
  if (keywords.length > 0) {
    doc.tag = keywords.map((name) => ({ type: "Hashtag", name }));
  }

  if (event.created !== undefined) doc.published = event.created;
  if (event.updated !== undefined) doc.updated = event.updated;

  return doc;
}

/**
 * The Event IRI a `Join`/`Leave` RSVP targets: its `object`, falling back to
 * `target`. Mobilizon and the event FEPs model an RSVP as a `Join` whose
 * `object` is the event being joined; some senders carry it as `target`
 * instead, so both are accepted. Returns `undefined` when neither names an IRI.
 */
export function participationTarget(
  activity: ActivityObject,
): string | undefined {
  return objectId(activity.object) ?? objectId(activity.target);
}
