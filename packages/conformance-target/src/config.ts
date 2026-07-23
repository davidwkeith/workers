/**
 * The conformance target's single env→config seam. `ConformanceEnv` is the
 * union of every mounted package's `Env` fragment — expressed as an interface
 * extends-chain so the compiler proves the fragments compose (shared bindings
 * like `BLOBS`, `GC_DB`, `AUTH_DB` must agree in type). `configsFor` builds
 * every package's config object from it; no package reads env directly
 * (spec/composition-contract.md).
 *
 * Not protocol logic: this package is deploy/test infrastructure and is never
 * published.
 *
 * @see docs/superpowers/specs/2026-07-04-conformance-target-design.md
 */

import type { ActivityPubConfig, ActivityPubEnv } from "@dwk/activitypub";
import type { AtprotoPdsConfig, AtprotoPdsEnv } from "@dwk/atproto-pds";
import type { HostMetaConfig, HostMetaEnv } from "@dwk/host-meta";
import type { IndieAuthConfig, IndieAuthEnv } from "@dwk/indieauth";
import type { MastodonApiConfig, MastodonApiEnv } from "@dwk/mastodon-api";
import type { MicropubConfig, MicropubEnv } from "@dwk/micropub";
import type { MicrosubConfig, MicrosubEnv } from "@dwk/microsub";
import type { RemoteStorageConfig, RemoteStorageEnv } from "@dwk/remotestorage";
import type { SolidPodConfig, SolidPodEnv } from "@dwk/solid-pod";
import type { VcConfig, VcEnv } from "@dwk/vc";
import type { WebAuthnConfig, WebAuthnEnv } from "@dwk/webauthn";
import type { WebfingerConfig, WebfingerEnv } from "@dwk/webfinger";
import type { WebmentionConfig, WebmentionEnv } from "@dwk/webmention";
import type { WebSubConfig, WebSubEnv } from "@dwk/websub";

import {
  approveAuthorization,
  approveMastodonAuthorization,
} from "./approval.js";
import { timingSafeEqual } from "./timing-safe-equal.js";

/** The local part of the test identity's `acct:` handle and AP username. */
export const USERNAME = "conformance";

/**
 * Union of every mounted package's Env fragment, plus this Worker's own vars
 * and secrets. The extends-chain is deliberate: it fails to compile if two
 * packages ever declare the same binding at incompatible types.
 */
export interface ConformanceEnv
  extends
    IndieAuthEnv,
    MastodonApiEnv,
    MicropubEnv,
    MicrosubEnv,
    WebmentionEnv,
    WebSubEnv,
    WebfingerEnv,
    HostMetaEnv,
    ActivityPubEnv,
    WebAuthnEnv,
    VcEnv,
    SolidPodEnv,
    RemoteStorageEnv,
    AtprotoPdsEnv {
  /** Public origin of the deployment (no trailing slash), e.g. `https://conformance.dwk.io`. */
  readonly BASE_URL: string;
  /** Always bound by this deployment; narrows the fragments' optional GC_DB. */
  readonly GC_DB: D1Database;
  /** Password for the IndieAuth consent form (secret). */
  readonly CONFORMANCE_PASSWORD: string;
  /** Shared-secret bearer that authenticates as the pod owner (secret; interim until Solid-OIDC, P4). */
  readonly CONFORMANCE_ADMIN_TOKEN: string;
  /** ActivityPub actor keypair (PEM; private half is a secret). */
  readonly ACTIVITYPUB_PUBLIC_KEY_PEM: string;
  readonly ACTIVITYPUB_PRIVATE_KEY_PEM: string;
  /**
   * Bearer for the owner publish endpoints (`POST <actor>/outbox` and
   * `/publish`) — the fedify suite's fanout/announce-unwrap cases drive them
   * (secret; optional: when unset, owner publishing stays disabled and those
   * cases report `skipped`).
   */
  readonly ACTIVITYPUB_PUBLISH_TOKEN?: string;
  /** atproto session credentials (secrets). */
  readonly ATPROTO_PASSWORD: string;
  readonly ATPROTO_JWT_SECRET: string;
}

/** The test identity's WebID (owner of both pods). */
export function ownerWebId(env: ConformanceEnv): string {
  return `${env.BASE_URL}/profile/card#me`;
}

/**
 * Interim owner authentication for the Solid pods: a shared-secret bearer
 * resolves to the owner WebID. Replaced by real Solid-OIDC in P4.
 */
function adminAuthenticate(
  env: ConformanceEnv,
): SolidPodConfig["authenticate"] {
  return (request) => {
    // Refuse outright when the secret is unset — otherwise a literal
    // "Bearer undefined" header would authenticate.
    const auth = request.headers.get("authorization");
    if (
      env.CONFORMANCE_ADMIN_TOKEN &&
      auth !== null &&
      timingSafeEqual(auth, `Bearer ${env.CONFORMANCE_ADMIN_TOKEN}`)
    ) {
      return {
        webid: ownerWebId(env),
        jti: crypto.randomUUID(),
        jkt: "conformance-admin",
      };
    }
    return null;
  };
}

export interface TargetConfigs {
  readonly webfinger: WebfingerConfig;
  readonly hostMeta: HostMetaConfig;
  readonly indieauth: IndieAuthConfig;
  readonly mastodonApi: Omit<MastodonApiConfig, "backend">;
  readonly micropub: MicropubConfig;
  readonly microsub: MicrosubConfig;
  readonly webmention: WebmentionConfig;
  readonly websub: WebSubConfig;
  readonly activitypub: ActivityPubConfig;
  readonly remotestorage: RemoteStorageConfig;
  readonly solidPod: SolidPodConfig;
  readonly davPod: SolidPodConfig;
  readonly webauthn: WebAuthnConfig;
  readonly vc: VcConfig;
  readonly atproto: AtprotoPdsConfig;
}

/** Build every package's config from the deployment env. */
export function configsFor(env: ConformanceEnv): TargetConfigs {
  const base = env.BASE_URL;
  const host = new URL(base).host;
  const me = `${base}/`;
  return {
    webfinger: {
      resources: {
        [`acct:${USERNAME}@${host}`]: {
          subject: `acct:${USERNAME}@${host}`,
          links: [
            {
              rel: "http://webfinger.net/rel/profile-page",
              href: me,
            },
            {
              rel: "self",
              type: "application/activity+json",
              href: `${base}/users/${USERNAME}`,
            },
          ],
        },
      },
    },
    hostMeta: { webfingerUrl: `${base}/.well-known/webfinger` },
    indieauth: {
      baseUrl: base,
      approveAuthorization: approveAuthorization(env),
    },
    mastodonApi: {
      baseUrl: base,
      instance: {
        title: "Conformance Target",
        description:
          "Deployed composition of the @dwk/workers packages; the target the hosted conformance suites run against.",
      },
      account: {
        username: USERNAME,
        displayName: "Conformance Target",
        // The target's first deploy (#227). Without this, clients render the
        // entity fallback epoch as "Joined December 31, 1969" (client-QA run
        // 2026-07-23, conformance/mastodon-client-qa.md).
        createdAt: "2026-07-05T18:30:44.000Z",
      },
      approveAuthorization: approveMastodonAuthorization(env),
    },
    micropub: { baseUrl: base, me },
    microsub: { baseUrl: base, me },
    webmention: { baseUrl: base },
    websub: {
      baseUrl: base,
      hubUrl: `${base}/websub`,
      allowedTopics: [me],
    },
    activitypub: {
      baseUrl: base,
      actor: { username: USERNAME, name: "Conformance Target" },
      publicKeyPem: env.ACTIVITYPUB_PUBLIC_KEY_PEM,
      privateKeyPem: env.ACTIVITYPUB_PRIVATE_KEY_PEM,
      ...(env.ACTIVITYPUB_PUBLISH_TOKEN
        ? { publishToken: env.ACTIVITYPUB_PUBLISH_TOKEN }
        : {}),
    },
    remotestorage: {
      baseUrl: base,
      parsePath: (pathname) => {
        const match = /^\/storage\/([^/]+)(\/.*)?$/.exec(pathname);
        if (!match || match[1] === undefined) return null;
        return {
          account: decodeURIComponent(match[1]),
          path: match[2] ?? "/",
        };
      },
    },
    solidPod: {
      baseUrl: `${base}/pod`,
      owner: ownerWebId(env),
      authenticate: adminAuthenticate(env),
    },
    // The litmus pod: its own DO (keyed by baseUrl), deliberately separate
    // from /pod — same-pod dual-door mounting is deferred to P4.
    davPod: {
      baseUrl: `${base}/dav`,
      owner: ownerWebId(env),
      authenticate: adminAuthenticate(env),
    },
    webauthn: {
      rpId: host,
      rpName: "dwk conformance target",
      origin: base,
    },
    vc: { baseUrl: base },
    atproto: {
      baseUrl: base,
      password: env.ATPROTO_PASSWORD,
      jwtSecret: env.ATPROTO_JWT_SECRET,
    },
  };
}
