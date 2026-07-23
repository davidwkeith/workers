/**
 * Configuration for {@link createMicropub}: the Micropub and media endpoint
 * URLs, the access-token issuer, advertised query/syndication metadata, the
 * media size ceiling, and the post-URL policy. Per the composition contract the
 * package never reads the global environment — every tunable arrives here, so
 * the handler can be instantiated multiple times and tested in isolation.
 */

import { canonicalizeProfileUrl } from "@dwk/indieauth";
import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";

import type { FediverseSyndicationConfig } from "./fediverse.js";
import type {
  MicropubContactStore,
  MicropubContactStoreEnv,
} from "./contacts.js";
import type { MicropubVenueStore } from "./venues.js";
import type { Mf2Object, MicropubCommands } from "./mf2.js";

/**
 * The maturity group a Micropub extension belongs to, per the approval stages
 * on [indieweb.org/Micropub-extensions](https://indieweb.org/Micropub-extensions):
 * `official` (adopted into the Micropub spec), `stable` (widely implemented and
 * settled), and `proposed` (experimental, may still change). A deployment
 * enables extensions a group at a time via {@link ExtensionGroupsConfig}.
 */
export type ExtensionMaturity = "official" | "stable" | "proposed";

/**
 * Which maturity groups of Micropub extensions this endpoint enables. Each new
 * extension is tagged with its group and only advertised/honoured when that
 * group is on. Defaults follow the wiki's maturity: `official` and `stable` on,
 * `proposed` off — so a deployment opts in to experimental behaviour explicitly.
 *
 * Already-shipped core commands (`mp-slug`, `mp-syndicate-to`) and the core
 * `q=source`/`q=config` queries are always available and are not gated here.
 */
export interface ExtensionGroupsConfig {
  /** Extensions adopted into the Micropub spec. Defaults to `true`. */
  readonly official?: boolean;
  /** Stable, widely-implemented extensions. Defaults to `true`. */
  readonly stable?: boolean;
  /** Proposed/experimental extensions. Defaults to `false`. */
  readonly proposed?: boolean;
}

/**
 * A post type advertised as `post-types` in `q=config` — the stable Supported
 * Vocabulary extension. Purely the site's editorial vocabulary shown to
 * clients; the store persists posts generically regardless of this list.
 */
export interface PostTypeConfig {
  /** The post type identifier, e.g. `"note"`, `"article"`, `"photo"`. */
  readonly type: string;
  /** Human-readable name shown in the client UI, e.g. `"Note"`. */
  readonly name: string;
}

/**
 * A named audience a client may assign to a private post when the proposed
 * Audience extension is enabled. `uid` is the persisted mf2 `audience` value;
 * `name` is display-only client metadata. The consuming site/WAC layer maps
 * these stable IDs to its own access-control rules.
 */
export interface AudienceConfig {
  /** Stable identifier a client stores in the `audience` mf2 property. */
  readonly uid: string;
  /** Human-readable label for the client's audience picker. */
  readonly name: string;
}

/** A syndication target advertised by `q=config` / `q=syndicate-to`. */
export interface SyndicationTarget {
  /** Stable identifier the client echoes back as `mp-syndicate-to`. */
  readonly uid: string;
  /** Human-readable name shown in the client's UI. */
  readonly name: string;
}

/**
 * An async source of syndication targets, for lists that change at runtime —
 * e.g. `@dwk/activitypub`'s `createCommunitySyndicationTargets`, which
 * advertises one target per followed fediverse community (#278).
 */
export type SyndicationTargetsProvider = () =>
  Promise<readonly SyndicationTarget[]> | readonly SyndicationTarget[];

/** Builds a request-bound Contacts store from the composed Worker bindings. */
export type MicropubContactStoreProvider = (
  env: MicropubContactStoreEnv,
) => MicropubContactStore;

/**
 * Derive the canonical URL of a newly created post from its microformats2
 * object and the parsed `mp-*` commands. Returning a relative path is allowed;
 * it is resolved against the configured `baseUrl`.
 */
export type GeneratePostUrl = (
  post: Mf2Object,
  commands: MicropubCommands,
) => string | Promise<string>;

/** Configuration passed to {@link createMicropub}. */
export interface MicropubConfig {
  /** The identity root / base URL (e.g. `https://example.com`). */
  readonly baseUrl: string;
  /**
   * The site owner's IndieAuth profile URL (`me`). A token only authorizes a
   * request when its subject (`sub`) equals this, after canonicalization — so a
   * token minted by the same issuer for a *different* `me` cannot publish here.
   * Required: a Micropub endpoint serves exactly one user's site.
   */
  readonly me: string;
  /** Absolute Micropub endpoint URL. Defaults to `${origin}/micropub`. */
  readonly micropubEndpoint?: string;
  /** Absolute media endpoint URL. Defaults to `${origin}/media`. */
  readonly mediaEndpoint?: string;
  /**
   * Expected access-token issuer (`iss`). Defaults to `baseUrl`, matching the
   * `@dwk/indieauth` issuer default.
   */
  readonly tokenIssuer?: string;
  /** Scopes advertised in `q=config`. Informational only. */
  readonly scopesSupported?: readonly string[];
  /**
   * Which maturity groups of Micropub extensions to enable (see
   * {@link ExtensionGroupsConfig}). Defaults to `official` + `stable` on,
   * `proposed` off.
   */
  readonly extensions?: ExtensionGroupsConfig;
  /**
   * Named audiences advertised to clients when `extensions.proposed` is on.
   * They are publishing metadata only: this package does not resolve contacts
   * or enforce access control for any audience.
   */
  readonly audiences?: readonly AudienceConfig[];
  /**
   * Private h-card store for the proposed Contacts extension. Contacts are
   * advertised only when this is set and the proposed group is enabled.
   */
  readonly contacts?: MicropubContactStore | MicropubContactStoreProvider;
  /**
   * Venue store for the proposed Location/Venue (`q=geo`) extension. Venues
   * are queried via proximity search and are independent from post storage.
   * The store enables `q=geo` when configured and the proposed group is enabled.
   */
  readonly venues?: MicropubVenueStore;
  /**
   * Post types advertised as `post-types` in `q=config` (the stable Supported
   * Vocabulary extension). Omitted from the response when unset, or when the
   * `stable` extension group is disabled.
   */
  readonly postTypes?: readonly PostTypeConfig[];
  /**
   * Syndication targets advertised by `q=config` / `q=syndicate-to` — a
   * static list, or an async provider for lists that change at runtime (e.g.
   * followed fediverse communities).
   */
  readonly syndicateTo?:
    readonly SyndicationTarget[] | SyndicationTargetsProvider;

  /**
   * Fediverse syndication (#278): when set, a create whose
   * `mp-syndicate-to` names the reserved `fediverse` uid or an advertised
   * community target is additionally published through
   * `@dwk/activitypub`'s `POST <actor>/publish` endpoint. Failures are
   * logged, never fatal to the post creation.
   */
  readonly fediverse?: FediverseSyndicationConfig;
  /** Maximum accepted media upload size in bytes. Defaults to 25 MiB. */
  readonly maxMediaBytes?: number;
  /**
   * Days soft-deleted media stays recoverable under the R2 `.trash/` prefix
   * before `undelete` permanently fails. Defaults to 30. Purging the trash
   * *bytes* is delegated to an R2 lifecycle rule the composed deployment
   * configures on the prefix; this window only drives the opportunistic
   * pruning of expired metadata rows (proposed media-endpoint extensions).
   */
  readonly mediaTrashRetentionDays?: number;
  /**
   * Whether to check each token against the issued-token store (revocation).
   * Defaults to `true` — staleness here is a security bug, so the check hits the
   * strongly-consistent `AUTH_DB` rather than any cache.
   */
  readonly checkRevocation?: boolean;
  /**
   * Whether to reject replayed DPoP proofs by tracking each accepted proof's
   * `jti` in the strongly-consistent `MICROPUB_DB`. Defaults to `true` — a
   * captured proof must not be replayable within its acceptance window to
   * repeat a state-changing request (RFC 9449 delegates replay detection to the
   * resource server).
   */
  readonly checkDpopReplay?: boolean;
  /** Post-URL policy (see {@link GeneratePostUrl}). */
  readonly generatePostUrl?: GeneratePostUrl;
  /**
   * Logger for auth/validation/action events; defaults to a no-op. Wire a real
   * logger (see `@dwk/log`) to surface authorization and validation rejections
   * instead of swallowing them.
   */
  readonly logger?: Logger;
  /**
   * Metrics sink for the same events; defaults to a no-op. Wire an adapter (e.g.
   * `analyticsEngineMetrics` from `@dwk/log`) to chart the same events the
   * logger names — auth rejections by reason, actions/min.
   */
  readonly metrics?: Metrics;
}

/** Fully resolved configuration with defaults applied and URLs parsed. */
export interface ResolvedConfig {
  /** The site owner's canonical IndieAuth profile URL (`me`). */
  readonly me: string;
  readonly micropubEndpoint: string;
  readonly mediaEndpoint: string;
  readonly micropubPath: string;
  readonly mediaPath: string;
  readonly tokenIssuer: string;
  readonly scopesSupported: readonly string[];
  /** Resolved per-group enablement flags (every group present). */
  readonly extensions: Readonly<Record<ExtensionMaturity, boolean>>;
  /** Named audience IDs accepted by the proposed Audience extension. */
  readonly audiences: readonly AudienceConfig[];
  /** Precomputed membership set for validating proposed audience IDs. */
  readonly audienceIds: ReadonlySet<string>;
  /** Normalized Contacts store provider, when the extension is configured. */
  readonly contacts?: MicropubContactStoreProvider;
  /** Normalized Venue store provider, when the extension is configured. */
  readonly venues?: MicropubVenueStore;
  readonly postTypes?: readonly PostTypeConfig[];
  /** Normalized to an async provider regardless of the configured shape. */
  readonly syndicateTo: () => Promise<readonly SyndicationTarget[]>;
  readonly fediverse?: FediverseSyndicationConfig;
  readonly maxMediaBytes: number;
  readonly mediaTrashRetentionDays: number;
  readonly checkRevocation: boolean;
  readonly checkDpopReplay: boolean;
  readonly generatePostUrl: GeneratePostUrl;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const DEFAULT_MEDIA_TRASH_RETENTION_DAYS = 30;

/** Lowercase, dash-separated slug derived from arbitrary text (max 80 chars). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** A short, collision-resistant slug: base36 timestamp plus random suffix. */
function randomSlug(): string {
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${time}-${rand}`;
}

/**
 * Default post-URL policy: prefer an explicit `mp-slug`, then a slug derived
 * from the `name` property, then a timestamp-based slug. The slug is appended to
 * `baseUrl` so subdirectory installs (e.g. `https://example.com/blog`) place
 * posts under the base path, e.g. `https://example.com/blog/<slug>`.
 */
function defaultGeneratePostUrl(baseUrl: string): GeneratePostUrl {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return (post, commands) => {
    const name = post.properties.name?.[0];
    const slug =
      commands.slug ||
      (typeof name === "string" && name ? slugify(name) : "") ||
      randomSlug();
    return `${base}${slug}`;
  };
}

/** Normalize `syndicateTo` (static list or provider) to an async provider. */
function normalizeSyndicateTo(
  syndicateTo:
    readonly SyndicationTarget[] | SyndicationTargetsProvider | undefined,
): () => Promise<readonly SyndicationTarget[]> {
  if (syndicateTo === undefined) return async () => [];
  if (typeof syndicateTo === "function") {
    return async () => syndicateTo();
  }
  return async () => syndicateTo;
}

function normalizeContactStore(
  contacts: MicropubContactStore | MicropubContactStoreProvider | undefined,
): MicropubContactStoreProvider | undefined {
  if (contacts === undefined) return undefined;
  return typeof contacts === "function" ? contacts : () => contacts;
}

function pathOf(absoluteUrl: string, label: string): string {
  try {
    return new URL(absoluteUrl).pathname;
  } catch {
    throw new Error(`@dwk/micropub: ${label} is not a valid URL`);
  }
}

/**
 * Resolve user config into a {@link ResolvedConfig}, applying defaults and
 * pre-computing each endpoint's pathname for request routing. Throws if
 * `baseUrl` (or any explicitly supplied endpoint URL) is not a valid URL.
 */
export function resolveConfig(config: MicropubConfig): ResolvedConfig {
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new Error("@dwk/micropub: `baseUrl` is not a valid URL");
  }
  const origin = base.origin;

  const me = canonicalizeProfileUrl(config.me);
  if (me === null) {
    throw new Error("@dwk/micropub: `me` is not a valid profile URL");
  }

  const micropubEndpoint = config.micropubEndpoint ?? `${origin}/micropub`;
  const mediaEndpoint = config.mediaEndpoint ?? `${origin}/media`;
  const contactStore = normalizeContactStore(config.contacts);
  const audiences = config.audiences ?? [];
  const audienceIds = new Set<string>();
  for (const audience of audiences) {
    if (!audience.uid || !audience.name) {
      throw new Error(
        "@dwk/micropub: every audience requires non-empty `uid` and `name`",
      );
    }
    if (audienceIds.has(audience.uid)) {
      throw new Error("@dwk/micropub: audience `uid` values must be unique");
    }
    audienceIds.add(audience.uid);
  }

  return {
    me,
    micropubEndpoint,
    mediaEndpoint,
    micropubPath: pathOf(micropubEndpoint, "micropubEndpoint"),
    mediaPath: pathOf(mediaEndpoint, "mediaEndpoint"),
    tokenIssuer: config.tokenIssuer ?? config.baseUrl,
    scopesSupported: config.scopesSupported ?? [
      "create",
      "update",
      "delete",
      "media",
    ],
    extensions: {
      official: config.extensions?.official ?? true,
      stable: config.extensions?.stable ?? true,
      proposed: config.extensions?.proposed ?? false,
    },
    audiences,
    audienceIds,
    ...(contactStore ? { contacts: contactStore } : {}),
    ...(config.venues ? { venues: config.venues } : {}),
    ...(config.postTypes ? { postTypes: config.postTypes } : {}),
    syndicateTo: normalizeSyndicateTo(config.syndicateTo),
    ...(config.fediverse ? { fediverse: config.fediverse } : {}),
    maxMediaBytes: config.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES,
    mediaTrashRetentionDays:
      config.mediaTrashRetentionDays ?? DEFAULT_MEDIA_TRASH_RETENTION_DAYS,
    checkRevocation: config.checkRevocation ?? true,
    checkDpopReplay: config.checkDpopReplay ?? true,
    generatePostUrl:
      config.generatePostUrl ?? defaultGeneratePostUrl(config.baseUrl),
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}
