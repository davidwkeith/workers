/**
 * `GET /api/v1/instance` and `GET /api/v2/instance` — public instance
 * metadata. Both versions ship because clients still call v1 first; the
 * `version` string is a GoToSocial-style compatibility marker.
 */

import { instanceV1Entity, instanceV2Entity } from "./entities.js";
import type { RouteContext } from "./handler.js";

function host(ctx: RouteContext): string {
  return new URL(ctx.config.baseUrl).host;
}

/** `GET /api/v1/instance`. */
export async function handleInstanceV1(ctx: RouteContext): Promise<Response> {
  return Response.json(instanceV1Entity(ctx.config, host(ctx)));
}

/** `GET /api/v2/instance`. */
export async function handleInstanceV2(ctx: RouteContext): Promise<Response> {
  return Response.json(instanceV2Entity(ctx.config, host(ctx)));
}
