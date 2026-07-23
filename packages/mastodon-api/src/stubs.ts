/**
 * Valid-but-empty stub endpoints. Clients call these at startup and several
 * hard-error on `404`/`500`, so each returns `200` with an empty-but-valid
 * body. The roster is data-driven so conformance runs can grow it without
 * new code paths (spec/mastodon-client-api.md, Decision 3).
 */

import { authenticateBearer } from "./auth.js";
import { invalidToken } from "./errors.js";
import type { RouteContext } from "./handler.js";
import { createMastodonStore } from "./store.js";

/** Mastodon `Preferences` defaults for a public, non-sensitive account. */
const PREFERENCES_DEFAULTS = {
  "posting:default:visibility": "public",
  "posting:default:sensitive": false,
  "posting:default:language": null,
  "reading:expand:media": "default",
  "reading:expand:spoilers": false,
} as const;

/** One valid-but-empty stub: `GET path` → `200` with `body`. */
export interface StubRoute {
  readonly path: string;
  /** Whether a valid bearer is required (`custom_emojis` is public). */
  readonly auth: boolean;
  readonly body: unknown;
}

/** The v1 roster (design's "valid-but-empty stubs" list, verbatim). */
export const STUB_ROUTES: readonly StubRoute[] = [
  // Exact routes match before the dynamic `accounts/:id` pattern, so this
  // keeps `relationships` from being misread as an account id (a real 404
  // Ice Cubes hit in the 2026-07-23 client-QA run).
  { path: "/api/v1/accounts/relationships", auth: true, body: [] },
  { path: "/api/v1/filters", auth: true, body: [] },
  { path: "/api/v2/filters", auth: true, body: [] },
  { path: "/api/v1/lists", auth: true, body: [] },
  { path: "/api/v1/custom_emojis", auth: false, body: [] },
  { path: "/api/v1/announcements", auth: true, body: [] },
  { path: "/api/v1/follow_requests", auth: true, body: [] },
  { path: "/api/v1/conversations", auth: true, body: [] },
  { path: "/api/v1/favourites", auth: true, body: [] },
  { path: "/api/v1/bookmarks", auth: true, body: [] },
  { path: "/api/v1/preferences", auth: true, body: PREFERENCES_DEFAULTS },
];

/** Build the `"GET <path>" → handler` entries the router registers. */
export function stubRouteEntries(): readonly [
  string,
  (ctx: RouteContext) => Promise<Response>,
][] {
  return STUB_ROUTES.map((stub) => [
    `GET ${stub.path}`,
    async (ctx: RouteContext): Promise<Response> => {
      if (stub.auth) {
        const token = await authenticateBearer(
          ctx.request,
          createMastodonStore(ctx.env),
        );
        if (!token) return invalidToken();
      }
      return Response.json(stub.body);
    },
  ]);
}
