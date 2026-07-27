/**
 * The mount table: external path → package handler, first match wins. Every
 * entry is built from `configsFor(env)` so the paths here and the endpoint
 * URLs the packages advertise cannot drift apart. Tasks 3–5 fill the table.
 */

import {
  createActivityPub,
  createActivitypubMastodonApi,
  resolveConfig,
} from "@dwk/activitypub";
import { createAtprotoPds } from "@dwk/atproto-pds";
import { createHostMeta } from "@dwk/host-meta";
import { createIndieAuth } from "@dwk/indieauth";
import { createMicropub } from "@dwk/micropub";
import { createMicrosub } from "@dwk/microsub";
import { createRemoteStorage } from "@dwk/remotestorage";
import {
  createSolidPod,
  createSolidPodWebdav,
  createSolidPodWebdavCredentials,
} from "@dwk/solid-pod";
import { createVc } from "@dwk/vc";
import { createWebAuthn } from "@dwk/webauthn";
import { createWebfinger } from "@dwk/webfinger";
import { createWebmention } from "@dwk/webmention";
import { createWebSub } from "@dwk/websub";

import { createAdminInit } from "./admin.js";
import { createConsent, createMastodonConsent } from "./approval.js";
import type { ConformanceEnv } from "./config.js";
import { configsFor, USERNAME } from "./config.js";
import { createHome } from "./home.js";
import { createWebmentionSendTrigger } from "./webmention-send.js";

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
      // Operator-only: one-time D1 schema init for a freshly deployed target
      // (see admin.ts and README.md's deploy runbook).
      name: "admin",
      matches: (u) => u.pathname === "/admin/init",
      handler: createAdminInit(env),
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
      // Deployer-owned consent submission for the Mastodon app OAuth
      // consent form — mirrors "consent" above, kept separate because the
      // Mastodon flow's authorization request has no PKCE code_challenge to
      // sign over (see approval.ts).
      name: "mastodon-consent",
      matches: (u) => u.pathname === "/mastodon-consent",
      handler: createMastodonConsent(env),
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
      // Owner-gated sender trigger — see webmention-send.ts. Distinct path
      // from the receiver mount above (exact "/webmention"), no collision.
      name: "@dwk/webmention (send trigger)",
      matches: (u) => u.pathname === "/webmention/send",
      handler: createWebmentionSendTrigger(env),
    },
    {
      name: "@dwk/websub",
      matches: (u) => u.pathname === "/websub",
      handler: createWebSub(c.websub),
    },
    {
      name: "@dwk/activitypub",
      matches: (u) =>
        u.pathname === `/users/${USERNAME}` ||
        u.pathname.startsWith(`/users/${USERNAME}/`) ||
        u.pathname === "/inbox" ||
        u.pathname === "/.well-known/nodeinfo" ||
        u.pathname.startsWith("/nodeinfo/"),
      handler: createActivityPub(c.activitypub),
    },
    {
      // Mastodon-compatible client API, read-only over the same actor DO
      // (@dwk/activitypub's createActivitypubMastodonApi adapter). Distinct
      // paths from the @dwk/indieauth mount above (`/authorize`, `/token`,
      // `/revocation`, no `/oauth/` prefix) — no collision.
      name: "@dwk/mastodon-api",
      matches: (u) =>
        u.pathname.startsWith("/api/v1/") ||
        u.pathname.startsWith("/api/v2/") ||
        u.pathname === "/oauth/authorize" ||
        u.pathname === "/oauth/token" ||
        u.pathname === "/oauth/revoke",
      handler: createActivitypubMastodonApi({
        config: resolveConfig(c.activitypub),
        actor: env.ACTOR,
        mastodonConfig: c.mastodonApi,
      }),
    },
    {
      name: "@dwk/remotestorage",
      matches: (u) => u.pathname.startsWith("/storage/"),
      handler: createRemoteStorage(c.remotestorage),
    },
    {
      name: "@dwk/solid-pod",
      matches: (u) => u.pathname === "/pod" || u.pathname.startsWith("/pod/"),
      handler: createSolidPod(c.solidPod),
    },
    {
      name: "@dwk/webdav (litmus pod door)",
      matches: (u) => u.pathname === "/dav" || u.pathname.startsWith("/dav/"),
      handler: createSolidPodWebdav(c.davPod),
    },
    {
      name: "@dwk/webdav (credentials)",
      matches: (u) => u.pathname === "/dav-credentials",
      handler: createSolidPodWebdavCredentials(c.davPod),
    },
    {
      name: "@dwk/webauthn",
      matches: (u) => u.pathname.startsWith("/webauthn/"),
      handler: createWebAuthn(c.webauthn),
    },
    {
      // Known limitation (P5, vc-data-model-2.0 suite): the VC issuer's
      // default did:web resolves to /.well-known/did.json, which the atproto
      // mount below serves with *its own* keys. An issue→verify round-trip
      // against the deployed target will fail DID resolution until the VC
      // issuer gets its own DID path. The smoke test below only proves the
      // mount answers, not full DID interop.
      name: "@dwk/vc",
      matches: (u) => u.pathname.startsWith("/credentials/"),
      handler: createVc(c.vc),
    },
    {
      name: "@dwk/atproto-pds",
      matches: (u) =>
        u.pathname.startsWith("/xrpc/") ||
        u.pathname === "/.well-known/atproto-did" ||
        u.pathname === "/.well-known/did.json",
      handler: createAtprotoPds(c.atproto),
    },
    {
      name: "home",
      matches: (u) =>
        u.pathname === "/" ||
        u.pathname === "/profile/card" ||
        u.pathname === "/webmention-qa-source",
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
