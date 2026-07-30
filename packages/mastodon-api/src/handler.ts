/**
 * `createMastodonApi` — the `/api/v1/*`, `/api/v2/*`, and `/oauth/*` router.
 * Routes are registered by feature modules; everything unrouted under `/api/`
 * gets Mastodon's 404 error shape. The whole surface is CORS-open (`*`) so
 * web clients (Elk, Phanpy) can call it; native apps ignore CORS.
 */

import {
  handleAccountCompanionStub,
  handleAccountStatuses,
  handleGetAccount,
  handleVerifyAccountCredentials,
} from "./accounts.js";
import { handleCreateApp, handleVerifyAppCredentials } from "./apps.js";
import type { MastodonApiConfig, MastodonApiEnv } from "./config.js";
import { recordNotFound } from "./errors.js";
import {
  handleFollowRequestRespond,
  handleFollowRequests,
} from "./follow-requests.js";
import { handleInstanceV1, handleInstanceV2 } from "./instance.js";
import { handleGetMarkers, handleSaveMarkers } from "./markers.js";
import { handleNotifications } from "./notifications.js";
import { handleAuthorize, handleRevoke, handleToken } from "./oauth-flow.js";
import { handleGetStatus } from "./statuses.js";
import { handleCreateStatus } from "./statuses-write.js";
import { stubRouteEntries } from "./stubs.js";
import { handleHomeTimeline } from "./timelines.js";

/** Per-request context threaded to route handlers. */
export interface RouteContext {
  readonly config: MastodonApiConfig;
  readonly env: MastodonApiEnv;
  readonly request: Request;
  readonly url: URL;
}

type RouteHandler = (ctx: RouteContext) => Promise<Response>;

/** Exact-path routes, keyed `"METHOD /path"`. Feature modules add entries. */
const ROUTES: ReadonlyMap<string, RouteHandler> = new Map<string, RouteHandler>(
  [
    ["POST /api/v1/apps", handleCreateApp],
    ["GET /api/v1/apps/verify_credentials", handleVerifyAppCredentials],
    ["GET /api/v1/accounts/verify_credentials", handleVerifyAccountCredentials],
    ["GET /api/v1/instance", handleInstanceV1],
    ["GET /api/v2/instance", handleInstanceV2],
    ["GET /api/v1/markers", handleGetMarkers],
    ["POST /api/v1/markers", handleSaveMarkers],
    ["GET /api/v1/timelines/home", handleHomeTimeline],
    ["POST /api/v1/statuses", handleCreateStatus],
    ["GET /api/v1/notifications", handleNotifications],
    ["GET /api/v1/follow_requests", handleFollowRequests],
    ["GET /oauth/authorize", handleAuthorize],
    ["POST /oauth/token", handleToken],
    ["POST /oauth/revoke", handleRevoke],
    ...stubRouteEntries(),
  ],
);

type DynamicRouteHandler = (ctx: RouteContext, id: string) => Promise<Response>;

/** `METHOD` + a regex capturing the one path parameter these routes need. */
const DYNAMIC_ROUTES: readonly [string, RegExp, DynamicRouteHandler][] = [
  [
    "GET",
    /^\/api\/v1\/statuses\/([^/]+)$/,
    (ctx, id) => handleGetStatus(ctx, id),
  ],
  [
    "GET",
    /^\/api\/v1\/accounts\/([^/]+)$/,
    (ctx, id) => handleGetAccount(ctx, id),
  ],
  [
    "GET",
    /^\/api\/v1\/accounts\/([^/]+)\/statuses$/,
    (ctx, id) => handleAccountStatuses(ctx, id),
  ],
  [
    "GET",
    /^\/api\/v1\/accounts\/([^/]+)\/(?:followers|following|featured_tags)$/,
    (ctx, id) => handleAccountCompanionStub(ctx, id),
  ],
  [
    "POST",
    /^\/api\/v1\/follow_requests\/([^/]+)\/authorize$/,
    (ctx, id) => handleFollowRequestRespond(ctx, id, "authorize"),
  ],
  [
    "POST",
    /^\/api\/v1\/follow_requests\/([^/]+)\/reject$/,
    (ctx, id) => handleFollowRequestRespond(ctx, id, "reject"),
  ],
];

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
} as const;

function withCors(response: Response): Response {
  const wrapped = new Response(response.body, response);
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    wrapped.headers.set(name, value);
  }
  return wrapped;
}

/** Create the Mastodon client-API handler (composition-contract shape). */
export function createMastodonApi(
  config: MastodonApiConfig,
): (
  request: Request,
  env: MastodonApiEnv,
  ctx: ExecutionContext,
) => Promise<Response> {
  return async (request, env, _ctx) => {
    if (!env.AUTH_DB) {
      throw new Error(
        "@dwk/mastodon-api: missing required D1 binding `AUTH_DB`",
      );
    }
    if (request.method.toUpperCase() === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const route = ROUTES.get(`${request.method.toUpperCase()} ${url.pathname}`);
    if (route) {
      return withCors(await route({ config, env, request, url }));
    }
    for (const [method, pattern, dynamicHandler] of DYNAMIC_ROUTES) {
      if (request.method.toUpperCase() !== method) continue;
      const match = pattern.exec(url.pathname);
      if (match?.[1]) {
        let id: string;
        try {
          id = decodeURIComponent(match[1]);
        } catch {
          return withCors(recordNotFound());
        }
        return withCors(
          await dynamicHandler({ config, env, request, url }, id),
        );
      }
    }
    return withCors(recordNotFound());
  };
}
