/**
 * The mount table: external path → package handler, first match wins. Every
 * entry is built from `configsFor(env)` so the paths here and the endpoint
 * URLs the packages advertise cannot drift apart. Tasks 3–5 fill the table.
 */

import { createHostMeta } from "@dwk/host-meta";
import { createIndieAuth } from "@dwk/indieauth";
import { createMicropub } from "@dwk/micropub";
import { createMicrosub } from "@dwk/microsub";
import { createWebfinger } from "@dwk/webfinger";
import { createWebmention } from "@dwk/webmention";
import { createWebSub } from "@dwk/websub";

import { createConsent } from "./approval.js";
import type { ConformanceEnv } from "./config.js";
import { configsFor } from "./config.js";
import { createHome } from "./home.js";

export type Handler = (
  request: Request,
  env: ConformanceEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

export interface Mount {
  /** Package name, for diagnostics. */
  readonly name: string;
  /** Whether this mount owns the request. */
  readonly matches: (url: URL, request: Request) => boolean;
  readonly handler: Handler;
}

/** Build the full mount table once per isolate. */
export function buildMounts(env: ConformanceEnv): readonly Mount[] {
  const c = configsFor(env);
  return [
    {
      name: "@dwk/webfinger",
      matches: (u) => u.pathname === "/.well-known/webfinger",
      handler: createWebfinger(c.webfinger),
    },
    {
      name: "@dwk/host-meta",
      matches: (u) =>
        u.pathname === "/.well-known/host-meta" ||
        u.pathname === "/.well-known/host-meta.json",
      handler: createHostMeta(c.hostMeta),
    },
    {
      // Deployer-owned consent submission for the IndieAuth consent form:
      // `POST /authorize` is the profile-URL redemption grant (owned by the
      // library), so the form posts here instead — see approval.ts.
      name: "consent",
      matches: (u) => u.pathname === "/consent",
      handler: createConsent(env),
    },
    {
      name: "@dwk/indieauth",
      matches: (u) =>
        u.pathname === "/.well-known/oauth-authorization-server" ||
        u.pathname === "/authorize" ||
        u.pathname === "/token" ||
        u.pathname === "/revocation",
      handler: createIndieAuth(c.indieauth),
    },
    {
      name: "@dwk/micropub",
      matches: (u) =>
        u.pathname === "/micropub" ||
        u.pathname === "/media" ||
        u.pathname.startsWith("/media/"),
      handler: createMicropub(c.micropub),
    },
    {
      name: "@dwk/microsub",
      matches: (u) => u.pathname === "/microsub",
      handler: createMicrosub(c.microsub),
    },
    {
      name: "@dwk/webmention",
      matches: (u) => u.pathname === "/webmention",
      handler: createWebmention(c.webmention),
    },
    {
      name: "@dwk/websub",
      matches: (u) => u.pathname === "/websub",
      handler: createWebSub(c.websub),
    },
    {
      name: "home",
      matches: (u) => u.pathname === "/" || u.pathname === "/profile/card",
      handler: createHome(env),
    },
  ];
}

/** Route a request through the mount table; unmatched paths are 404. */
export function routeRequest(
  mounts: readonly Mount[],
  request: Request,
  env: ConformanceEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  for (const mount of mounts) {
    if (mount.matches(url, request)) return mount.handler(request, env, ctx);
  }
  return Promise.resolve(new Response("Not Found", { status: 404 }));
}
