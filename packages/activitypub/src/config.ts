/**
 * Configuration, the declared Cloudflare `Env` fragment, and config resolution
 * for `@dwk/activitypub`.
 *
 * Per the composition contract the package never reads the global environment
 * directly: the actor profile, key material, and delivery policy are all passed
 * into {@link createActivityPub}, so an actor can be instantiated multiple times
 * and unit-tested in isolation. The only runtime coupling is the per-actor
 * Durable Object namespace, and a missing binding fails loudly at startup.
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";

import type { ActorIris, ActorProfile } from "./as2.js";
import type {
  KeyResolver,
  ResolvedKey,
  VerifyResult,
  InboxRequest,
} from "./signature.js";
import type { SoftwareInfo } from "./nodeinfo.js";
import type { ActivityPubObject } from "./object.js";

/** Cloudflare bindings required by the ActivityPub handler and Durable Object. */
export interface ActivityPubEnv {
  /**
   * Durable Object namespace for the per-actor class
   * ({@link ActivityPubObject}). The single authoritative store for the inbox,
   * outbox, follower/following collections, activity-`id` dedup, and the
   * delivery queue.
   */
  readonly ACTOR: DurableObjectNamespace<ActivityPubObject>;
}

/** How group-relayed (`Announce`-unwrapped) activities are origin-verified. */
export type RelayVerificationMode = "tiered" | "immediate" | "off";

/** An override for inbound signature verification (see `@dwk/http-signatures`, #59). */
export type InboxVerifier = (
  request: InboxRequest,
) => Promise<VerifyResult> | VerifyResult;

/** Configuration passed to {@link createActivityPub}. */
export interface ActivityPubConfig {
  /**
   * The actor's identity root / base URL, e.g. `https://example.com`. The actor
   * IRI and every collection IRI are derived from it. No trailing slash. Mount
   * the package under a path prefix by including it here (e.g.
   * `https://example.com/ap`).
   */
  readonly baseUrl: string;

  /** The single actor this deployment serves (v1 is one actor per `baseUrl`). */
  readonly actor: ActorProfile;

  /**
   * The domain used in the actor's WebFinger handle (`<username>@<domain>`),
   * federated as the FEP-2c59 `webfinger` property on the actor document.
   * Defaults to the host of {@link baseUrl}. Override when the handle domain
   * differs from the actor-URL host (e.g. handles live on the apex while the
   * actor is served from a subdomain).
   */
  readonly acctDomain?: string;

  /**
   * PEM-encoded SPKI **public** key, published inline in the actor document so
   * peers can verify this actor's outbound signatures.
   */
  readonly publicKeyPem: string;

  /**
   * PEM-encoded PKCS#8 **private** key (a secret binding's value) used to sign
   * outbound deliveries. Required to federate outbound (e.g. `Accept` a follow);
   * omit it for a read-only actor that never delivers.
   */
  readonly privateKeyPem?: string;

  /**
   * Bearer token authorizing the owner-only publish endpoint
   * (`POST <actor>/outbox`). When unset, that endpoint is disabled. This is the
   * `@dwk/micropub` publish → `Create` fan-out seam; full C2S is out of scope
   * for v1.
   */
  readonly publishToken?: string;

  /**
   * Whether to serve and advertise an instance-level **shared inbox** at
   * `${baseUrl}/inbox` (ActivityPub §4.1 / §7.1.3), letting large peers
   * batch-deliver to this actor. Defaults to `true`; set `false` to publish no
   * `endpoints.sharedInbox` and serve no shared-inbox route.
   */
  readonly sharedInbox?: boolean;

  /**
   * Whether inbound event RSVPs require manual approval. When `false` (the
   * default) a `Join` targeting an event this actor owns is auto-`Accept`ed —
   * the participant is recorded `accepted` and a signed `Accept` is delivered to
   * their inbox, mirroring the auto-`Accept` of a `Follow`. When `true` the
   * participant is recorded `pending` and no `Accept` is sent; emitting the
   * eventual `Accept`/`Reject` is a C2S concern (out of scope for v1, like
   * manual follower approval).
   */
  readonly manuallyApprovesJoins?: boolean;

  /**
   * Origin verification for group-relayed (FEP-1b12 `Announce`-unwrapped)
   * activities — always asynchronous, never in the inbox POST path
   * (spec/fediverse-interop.md §2.2):
   *
   * - `"tiered"` (default): content (`Create`/`Update`/`Delete`) is verified
   *   on the next alarm tick; votes (`Like`/`Dislike`) are verified in
   *   periodic batched sweeps and stay provisional until swept.
   * - `"immediate"`: every relayed activity verifies on the next alarm tick.
   * - `"off"`: trust the followed group; rows stay `pending` and rely on
   *   their `relayed_by` provenance alone.
   */
  readonly verifyRelayedObjects?: RelayVerificationMode;

  /** Members served per `OrderedCollection` page. Defaults to 50. */
  readonly pageSize?: number;

  /** Max delivery attempts before a queued activity is dropped. Defaults to 8. */
  readonly deliveryMaxAttempts?: number;

  /** Base backoff (ms) for delivery retries (doubled per attempt). Defaults to 60_000. */
  readonly deliveryBaseDelayMs?: number;

  /** Accepted clock skew (seconds) on inbound signed `Date` headers. Defaults to 300. */
  readonly clockSkewSeconds?: number;

  /** Software identity for the NodeInfo document. Defaults to this package. */
  readonly software?: SoftwareInfo;

  /**
   * Resolve a `keyId` to its owner + PEM key for inbound verification. Defaults
   * to fetching the `keyId` (an actor or key IRI) as AS2 and reading
   * `publicKey`. Supply your own to add caching or a key store.
   */
  readonly keyResolver?: KeyResolver;

  /**
   * Override inbound signature verification entirely (e.g. to plug in
   * `@dwk/http-signatures`). When set, the built-in draft-cavage verifier and
   * {@link keyResolver} are bypassed.
   */
  readonly verifyInboxSignature?: InboxVerifier;

  /** `fetch` used for key resolution and outbound delivery. Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;

  /** Injectable clock (epoch ms) for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;

  /** Structured-logging seam; defaults to a no-op. */
  readonly logger?: Logger;
  /** Metrics seam; defaults to a no-op. */
  readonly metrics?: Metrics;

  /**
   * TEMPORARY (fediverse conformance debugging, #273/#315) — opt into the
   * signature-rejection diagnostic block in `handler.ts`: on a failed inbound
   * signature check, the response body additionally echoes the request's own
   * `signature`/`signature-input`/`content-type`/`digest`/`date`/`host`
   * headers and, for `key_unresolved`, the *parsed* (never re-fetched)
   * `keyId`. Defaults to `false` and MUST stay off for any real deployment —
   * an inbox is public, so this is only ever safe on a disposable debug
   * target you are actively watching. Never set this outside that.
   */
  readonly debugSignatureDiagnostics?: boolean;
}

/** Fully-resolved configuration with defaults applied and IRIs derived. */
export interface ResolvedConfig {
  readonly baseUrl: string;
  readonly actor: ActorProfile;
  readonly iris: ActorIris;
  /** The actor's canonical WebFinger handle, `acct:<username>@<domain>` (FEP-2c59). */
  readonly webfinger: string;
  /** Instance-level shared inbox IRI, or `undefined` when not served. */
  readonly sharedInbox?: string;
  /** Whether inbound event RSVPs (`Join`) are held `pending` instead of auto-accepted. */
  readonly manuallyApprovesJoins: boolean;
  readonly verifyRelayedObjects: RelayVerificationMode;
  /** TEMPORARY (#273/#315) — see {@link ActivityPubConfig.debugSignatureDiagnostics}. */
  readonly debugSignatureDiagnostics: boolean;
  readonly publicKeyPem: string;
  readonly privateKeyPem?: string;
  readonly publishToken?: string;
  readonly pageSize: number;
  readonly deliveryMaxAttempts: number;
  readonly deliveryBaseDelayMs: number;
  readonly clockSkewSeconds: number;
  readonly software: SoftwareInfo;
  readonly keyResolver: KeyResolver;
  readonly verifyInboxSignature?: InboxVerifier;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/**
 * Internal headers the trusted front door uses to hand verified facts and the
 * config subset the DO needs (including signing key material, which never leaves
 * Cloudflare's network) to the Durable Object.
 */
export const INTERNAL_HEADERS = {
  /** The verified actor IRI that signed an inbound `POST /inbox` (absent ⇒ unverified). */
  signedActor: "x-ap-signed-actor",
  /** JSON config subset the DO needs (IRIs, delivery policy, signing key). */
  config: "x-ap-config",
  /** Marks an owner-authorized publish request (`POST <actor>/outbox`). */
  publish: "x-ap-publish",
} as const;

/** The config subset the front door forwards to the DO via {@link INTERNAL_HEADERS.config}. */
export interface ForwardedConfig {
  readonly iris: ActorIris;
  readonly actorName: string;
  /** Shared inbox IRI the DO should also accept inbound `POST`s on, if served. */
  readonly sharedInbox?: string;
  readonly manuallyApprovesFollowers: boolean;
  /** Whether inbound event RSVPs (`Join`) are held `pending` instead of auto-accepted. */
  readonly manuallyApprovesJoins: boolean;
  /** Origin-verification mode for group-relayed activities (§2.2). */
  readonly verifyRelayedObjects: RelayVerificationMode;
  readonly pageSize: number;
  readonly deliveryMaxAttempts: number;
  readonly deliveryBaseDelayMs: number;
  readonly keyId: string;
  /** Private key (PKCS#8 PEM) so the DO can sign deliveries from its alarm. */
  readonly privateKeyPem?: string;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BASE_DELAY_MS = 60_000;
const DEFAULT_CLOCK_SKEW_SECONDS = 300;

const DEFAULT_SOFTWARE: SoftwareInfo = {
  name: "dwk-activitypub",
  version: "0.0.0",
};

/** Strip a trailing slash so path joins are unambiguous. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/** Derive the actor + collection IRIs from a base URL and username. */
export function deriveIris(baseUrl: string, username: string): ActorIris {
  const id = `${baseUrl}/users/${encodeURIComponent(username)}`;
  return {
    id,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,
    keyId: `${id}#main-key`,
  };
}

/**
 * The default key resolver: fetch the `keyId` (an actor or fragment IRI) as AS2
 * and read its embedded `publicKey`. Returns `null` when the document cannot be
 * fetched or carries no usable key, which the verifier maps to a rejection.
 */
function defaultKeyResolver(fetchImpl: typeof fetch): KeyResolver {
  return async (keyId: string): Promise<ResolvedKey | null> => {
    // The key IRI is the actor (or key) document URL with its fragment
    // stripped. Parse it as a URL so the fragment is removed per the URL spec
    // (rather than by string surgery) and an unparseable `keyId` is rejected
    // before it reaches `fetch`.
    let actorUrl: string;
    try {
      const url = new URL(keyId);
      // Only ever dereference a remote actor/key document over HTTP(S); reject
      // other schemes (`file:`, `data:`, …) outright so a crafted `keyId`
      // cannot redirect the fetch at a non-network resource.
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      url.hash = "";
      actorUrl = url.href;
    } catch {
      return null;
    }
    let response: Response;
    try {
      response = await fetchImpl(actorUrl, {
        headers: { accept: "application/activity+json" },
        // Bound key resolution so a slow remote cannot stall inbox verification.
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    let doc: unknown;
    try {
      doc = await response.json();
    } catch {
      return null;
    }
    if (!doc || typeof doc !== "object") return null;
    const publicKey = (doc as Record<string, unknown>).publicKey;
    if (!publicKey || typeof publicKey !== "object") return null;
    const pem = (publicKey as Record<string, unknown>).publicKeyPem;
    const owner =
      (publicKey as Record<string, unknown>).owner ??
      (doc as Record<string, unknown>).id;
    if (typeof pem !== "string" || typeof owner !== "string") return null;
    return { owner, publicKeyPem: pem };
  };
}

/** Apply defaults and derive IRIs from raw {@link ActivityPubConfig}. */
export function resolveConfig(config: ActivityPubConfig): ResolvedConfig {
  if (!config.baseUrl) {
    throw new Error("@dwk/activitypub: `baseUrl` is required");
  }
  if (!config.actor || !config.actor.username) {
    throw new Error("@dwk/activitypub: `actor.username` is required");
  }
  if (!config.publicKeyPem) {
    throw new Error("@dwk/activitypub: `publicKeyPem` is required");
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const fetchImpl = config.fetch ?? fetch;
  const sharedInbox =
    (config.sharedInbox ?? true) ? `${baseUrl}/inbox` : undefined;
  // FEP-2c59 handle: the WebFinger `acct:` URI for this actor. The domain
  // defaults to the actor-URL hostname (not `host` — a WebFinger handle never
  // carries a port) but may be overridden when handles live on a different
  // domain than the actor is served from.
  const acctDomain = config.acctDomain ?? new URL(baseUrl).hostname;
  const webfinger = `acct:${config.actor.username}@${acctDomain}`;

  return {
    baseUrl,
    actor: config.actor,
    iris: deriveIris(baseUrl, config.actor.username),
    webfinger,
    sharedInbox,
    manuallyApprovesJoins: config.manuallyApprovesJoins ?? false,
    debugSignatureDiagnostics: config.debugSignatureDiagnostics ?? false,
    verifyRelayedObjects: config.verifyRelayedObjects ?? "tiered",
    publicKeyPem: config.publicKeyPem,
    privateKeyPem: config.privateKeyPem,
    publishToken: config.publishToken,
    pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE,
    deliveryMaxAttempts: config.deliveryMaxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    deliveryBaseDelayMs: config.deliveryBaseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    clockSkewSeconds: config.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS,
    software: config.software ?? DEFAULT_SOFTWARE,
    keyResolver: config.keyResolver ?? defaultKeyResolver(fetchImpl),
    verifyInboxSignature: config.verifyInboxSignature,
    fetch: fetchImpl,
    now: config.now ?? (() => Date.now()),
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}
