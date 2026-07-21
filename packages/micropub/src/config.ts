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
  readonly postTypes?: readonly PostTypeConfig[];
  /** Normalized to an async provider regardless of the configured shape. */
  readonly syndicateTo: () => Promise<readonly SyndicationTarget[]>;
  readonly fediverse?: FediverseSyndicationConfig;
  readonly maxMediaBytes: number;
  readonly checkRevocation: boolean;
  readonly checkDpopReplay: boolean;
  readonly generatePostUrl: GeneratePostUrl;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;

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
    ...(config.postTypes ? { postTypes: config.postTypes } : {}),
    syndicateTo: normalizeSyndicateTo(config.syndicateTo),
    ...(config.fediverse ? { fediverse: config.fediverse } : {}),
    maxMediaBytes: config.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES,
    checkRevocation: config.checkRevocation ?? true,
    checkDpopReplay: config.checkDpopReplay ?? true,
    generatePostUrl:
      config.generatePostUrl ?? defaultGeneratePostUrl(config.baseUrl),
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}
