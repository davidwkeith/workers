/**
 * Configuration for {@link createMicropub}: the Micropub and media endpoint
 * URLs, the access-token issuer, advertised query/syndication metadata, the
 * media size ceiling, and the post-URL policy. Per the composition contract the
 * package never reads the global environment — every tunable arrives here, so
 * the handler can be instantiated multiple times and tested in isolation.
 */

import type { Mf2Object, MicropubCommands } from "./mf2";

/** A syndication target advertised by `q=config` / `q=syndicate-to`. */
export interface SyndicationTarget {
  /** Stable identifier the client echoes back as `mp-syndicate-to`. */
  readonly uid: string;
  /** Human-readable name shown in the client's UI. */
  readonly name: string;
}

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
  /** Syndication targets advertised by `q=config` / `q=syndicate-to`. */
  readonly syndicateTo?: readonly SyndicationTarget[];
  /** Maximum accepted media upload size in bytes. Defaults to 25 MiB. */
  readonly maxMediaBytes?: number;
  /**
   * Whether to check each token against the issued-token store (revocation).
   * Defaults to `true` — staleness here is a security bug, so the check hits the
   * strongly-consistent `AUTH_DB` rather than any cache.
   */
  readonly checkRevocation?: boolean;
  /** Post-URL policy (see {@link GeneratePostUrl}). */
  readonly generatePostUrl?: GeneratePostUrl;
}

/** Fully resolved configuration with defaults applied and URLs parsed. */
export interface ResolvedConfig {
  readonly micropubEndpoint: string;
  readonly mediaEndpoint: string;
  readonly micropubPath: string;
  readonly mediaPath: string;
  readonly tokenIssuer: string;
  readonly scopesSupported: readonly string[];
  readonly syndicateTo: readonly SyndicationTarget[];
  readonly maxMediaBytes: number;
  readonly checkRevocation: boolean;
  readonly generatePostUrl: GeneratePostUrl;
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
 * from the `name` property, then a timestamp-based slug. The result is a path
 * under the origin, e.g. `https://example.com/<slug>`.
 */
function defaultGeneratePostUrl(origin: string): GeneratePostUrl {
  return (post, commands) => {
    const name = post.properties.name?.[0];
    const slug =
      commands.slug ||
      (typeof name === "string" && name ? slugify(name) : "") ||
      randomSlug();
    return `${origin}/${slug}`;
  };
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

  const micropubEndpoint = config.micropubEndpoint ?? `${origin}/micropub`;
  const mediaEndpoint = config.mediaEndpoint ?? `${origin}/media`;

  return {
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
    syndicateTo: config.syndicateTo ?? [],
    maxMediaBytes: config.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES,
    checkRevocation: config.checkRevocation ?? true,
    generatePostUrl: config.generatePostUrl ?? defaultGeneratePostUrl(origin),
  };
}
