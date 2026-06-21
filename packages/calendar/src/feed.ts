/**
 * An optional, stateless `text/calendar` feed handler — the serving seam for a
 * subscribable `webcal://` calendar. It is config-injected and binding-free: the
 * events are supplied by a resolver the host wires to its own store (D1, a pod,
 * a Micropub post list), never read from the global environment, so this lib
 * stays pure and the handler unit-tests under Node.
 *
 * This is the one part of `@dwk/calendar` that touches the `fetch` types; the
 * serializers ({@link "./icalendar"}, {@link "./jscalendar"}) remain plain
 * data-in/string-out. A host that only needs the bytes can call
 * {@link toICalendarFeed} directly and skip this handler entirely.
 *
 * @packageDocumentation
 */

import type { CalendarEvent } from "./model.js";
import { type ICalendarOptions, toICalendarFeed } from "./icalendar.js";

/** Configuration for {@link createCalendarFeed}. */
export interface CalendarFeedConfig extends Omit<ICalendarOptions, "now"> {
  /**
   * Resolve the events to serve for a request. Receives the `Request` so the
   * host can scope by path/query (a per-category feed, a date window, …). May be
   * async (a store read). Required — construction throws without it.
   */
  readonly events: (
    request: Request,
  ) => readonly CalendarEvent[] | Promise<readonly CalendarEvent[]>;
  /** `DTSTAMP`/generation clock; injectable for deterministic output. Defaults to `Date.now`. */
  readonly now?: () => Date;
  /** `Content-Disposition` filename for the download. Defaults to `calendar.ics`. */
  readonly filename?: string;
  /** `Cache-Control` header value. Defaults to a short shared-cache TTL. */
  readonly cacheControl?: string;
}

/** A `fetch`-compatible handler, mountable under a path prefix in a composed Worker. */
export type CalendarFeedHandler = (
  request: Request,
  env?: unknown,
  ctx?: unknown,
) => Promise<Response>;

/**
 * Build a `text/calendar` feed handler. Serves `GET`/`HEAD` (others `405`), with
 * the resolver's events rendered via {@link toICalendarFeed} and the
 * subscription-friendly headers a `webcal://` client expects.
 *
 * Fails loudly at construction — per the composition contract — when no `events`
 * resolver is supplied, rather than serving an empty calendar at runtime.
 */
export function createCalendarFeed(
  config: CalendarFeedConfig,
): CalendarFeedHandler {
  if (typeof config.events !== "function") {
    throw new Error(
      "createCalendarFeed requires an `events` resolver function",
    );
  }
  const filename = config.filename ?? "calendar.ics";
  const cacheControl = config.cacheControl ?? "public, max-age=3600";
  const serializerOptions: ICalendarOptions = {
    prodId: config.prodId,
    calName: config.calName,
    refreshInterval: config.refreshInterval,
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const events = await config.events(request);
    const body = toICalendarFeed(events, {
      ...serializerOptions,
      now: config.now?.() ?? new Date(),
    });

    const headers = new Headers({
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": cacheControl,
    });
    // A HEAD response carries the headers but no body.
    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers,
    });
  };
}
