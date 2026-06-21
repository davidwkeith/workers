/**
 * Microformats2 `h-event` support for Micropub: recognizing the event post type
 * and rendering a stored event back to canonical `h-event` markup.
 *
 * Per the IndieWeb model an event *is* HTML on the author's page marked up as
 * `h-event` (`p-name`, `dt-start`, `dt-end`, `p-location`, `p-category`,
 * `e-content`) — the page is the source of truth the calendar / federation
 * layers serialize from. Micropub creates the event with the spec's `h=event`
 * post type (stored generically by {@link MicropubStore}); this module turns the
 * stored microformats2 object into the `h-event` markup a consuming site
 * publishes. Pure and runtime-free — plain mf2 in, an HTML string out — so it
 * unit-tests without a Workers runtime.
 *
 * @see https://micropub.spec.indieweb.org/#h-event
 * @see https://microformats.org/wiki/h-event
 */

import type { CalendarEvent, EventLink } from "@dwk/calendar";

import type { Mf2Object } from "./mf2.js";

/** The microformats2 type of an event. */
export const H_EVENT = "h-event";

/** Whether a parsed mf2 object carries the `h-event` type. */
export function isEvent(mf2: Mf2Object): boolean {
  return mf2.type.includes(H_EVENT);
}

/** The mf2 property-class prefix that governs how a value is marked up. */
type Mf2Prefix = "p" | "u" | "dt" | "e";

/**
 * The mf2 prefix for each known `h-event` property. Drives the element and
 * attribute chosen by {@link renderHEvent}: `u-*` becomes an anchor `href`,
 * `dt-*` a `<time datetime>`, `e-*` an HTML content block, and `p-*` plain text.
 * An unlisted property falls back to `p-*`, the safe default for a text value.
 */
const EVENT_PROPERTY_PREFIX: Readonly<Record<string, Mf2Prefix>> = {
  name: "p",
  summary: "p",
  location: "p",
  category: "p",
  start: "dt",
  end: "dt",
  duration: "dt",
  published: "dt",
  updated: "dt",
  url: "u",
  uid: "u",
  featured: "u",
  content: "e",
};

/** Escape text/attribute content for safe interpolation into HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Whether a `u-*` value is safe to emit as an `href`. Relative URLs and ordinary
 * schemes pass; script-bearing schemes (`javascript:`, `data:`, `vbscript:`) are
 * rejected so a rendered event page can never carry an injected script URL —
 * defence in depth, even though only the authenticated site owner authors posts.
 * Whitespace and control characters are stripped before the scheme test because
 * a browser ignores them when resolving an `href` (e.g. `java\tscript:`).
 */
function isSafeUrl(value: string): boolean {
  // Drop ASCII whitespace/control chars (code point <= 0x20) before testing the
  // scheme, since a browser ignores them when resolving an href (`java\tscript:`).
  let stripped = "";
  for (const ch of value) {
    if (ch.charCodeAt(0) > 0x20) stripped += ch;
  }
  return !/^(?:javascript|data|vbscript):/i.test(stripped);
}

/**
 * Coerce an mf2 property value to display text. A bare string is itself; a
 * nested object yields its `value` (the mf2 parsed-value convention) or, failing
 * that, the `name` of a nested microformat (e.g. a location `h-card`). Anything
 * else has no text projection.
 */
function valueToText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.value === "string") {
      return obj.value;
    }
    const props = obj.properties as
      | Record<string, readonly unknown[]>
      | undefined;
    const name = props?.name?.[0];
    if (typeof name === "string") {
      return name;
    }
  }
  return null;
}

/** Render one property value as a microformats2 element, or `null` to skip it. */
function renderValue(prefix: Mf2Prefix, key: string, value: unknown): string {
  const cls = `${prefix}-${key}`;
  if (prefix === "e") {
    // `e-*` carries HTML: an `{ html }` parsed value is emitted verbatim, a
    // plain string is escaped as text.
    const html =
      value !== null &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).html === "string"
        ? ((value as Record<string, unknown>).html as string)
        : escapeHtml(valueToText(value) ?? "");
    return `<div class="${cls}">${html}</div>`;
  }
  const text = valueToText(value);
  if (text === null) {
    return "";
  }
  const escaped = escapeHtml(text);
  if (prefix === "u") {
    const href = isSafeUrl(text) ? escaped : "#";
    return `<a class="${cls}" href="${href}">${escaped}</a>`;
  }
  if (prefix === "dt") {
    return `<time class="${cls}" datetime="${escaped}">${escaped}</time>`;
  }
  return `<span class="${cls}">${escaped}</span>`;
}

/** First value of an mf2 property, coerced to display text, or `undefined`. */
function firstText(event: Mf2Object, key: string): string | undefined {
  const values = event.properties?.[key];
  if (!Array.isArray(values)) {
    return undefined;
  }
  for (const value of values) {
    const text = valueToText(value);
    if (text !== null) {
      return text;
    }
  }
  return undefined;
}

/** All values of an mf2 property coerced to text (skipping unprojectable ones). */
function allText(event: Mf2Object, key: string): string[] {
  const values = event.properties?.[key];
  if (!Array.isArray(values)) {
    return [];
  }
  const out: string[] = [];
  for (const value of values) {
    const text = valueToText(value);
    if (text !== null) {
      out.push(text);
    }
  }
  return out;
}

/**
 * Bridge a stored `h-event` microformats2 object to the canonical
 * {@link CalendarEvent} model from `@dwk/calendar`, the shared record the `.ics`
 * and JSCalendar serializers read. This adapter is the IndieWeb-specific seam
 * that the cross-standard `@dwk/calendar` lib deliberately does not contain (it
 * must stay free of IndieWeb assumptions), so the h-event vocabulary knowledge
 * lives here, where the mf2 shape is already understood.
 *
 * The event's identity comes from its `uid`, falling back to its `url` — a
 * calendar entry needs a stable id to be re-subscribable, so an event carrying
 * neither is rejected. `name`→title, `summary`/`content`→description,
 * `dt-start`/`dt-end`→start/end, `location`→locations, `category`→keywords, and
 * `url`→a link are mapped; `published`/`updated` carry timestamps through. Pure:
 * plain mf2 in, a plain `CalendarEvent` out.
 */
export function hEventToCalendarEvent(event: Mf2Object): CalendarEvent {
  const uid = firstText(event, "uid") ?? firstText(event, "url");
  if (!uid) {
    throw new Error(
      "cannot convert h-event to a calendar event: no `uid` or `url` for a stable identity",
    );
  }
  const start = firstText(event, "start");
  if (!start) {
    throw new Error(
      `cannot convert h-event ${uid} to a calendar event: no \`start\``,
    );
  }

  const locations = allText(event, "location").map((name) => ({ name }));
  const keywords = allText(event, "category");
  const links: EventLink[] = allText(event, "url").map((href) => ({ href }));

  return {
    uid,
    start,
    ...(firstText(event, "name") !== undefined
      ? { title: firstText(event, "name") }
      : {}),
    ...((firstText(event, "summary") ?? firstText(event, "content"))
      ? {
          description:
            firstText(event, "summary") ?? firstText(event, "content"),
        }
      : {}),
    ...(firstText(event, "end") !== undefined
      ? { end: firstText(event, "end") }
      : {}),
    ...(firstText(event, "duration") !== undefined
      ? { duration: firstText(event, "duration") }
      : {}),
    ...(locations.length ? { locations } : {}),
    ...(keywords.length ? { keywords } : {}),
    ...(links.length ? { links } : {}),
    ...(firstText(event, "published") !== undefined
      ? { created: firstText(event, "published") }
      : {}),
    ...(firstText(event, "updated") !== undefined
      ? { updated: firstText(event, "updated") }
      : {}),
  };
}

/**
 * Render a stored event's microformats2 object to canonical `h-event` HTML.
 *
 * Each property is emitted with its mf2 prefix class (see
 * {@link EVENT_PROPERTY_PREFIX}) so the markup round-trips through an mf2 parser
 * back to the same properties. The output is a single `h-event` root the
 * consuming site embeds in its page. Pure: it neither stores nor fetches.
 */
export function renderHEvent(event: Mf2Object): string {
  const parts: string[] = [];
  // `?? {}` and the array guard tolerate a malformed/partial mf2 object reaching
  // this public helper — a missing or non-array property is skipped, not thrown.
  for (const [key, values] of Object.entries(event.properties ?? {})) {
    if (!Array.isArray(values)) {
      continue;
    }
    const prefix = EVENT_PROPERTY_PREFIX[key] ?? "p";
    for (const value of values) {
      parts.push(renderValue(prefix, key, value));
    }
  }
  return `<div class="h-event">${parts.join("")}</div>`;
}
