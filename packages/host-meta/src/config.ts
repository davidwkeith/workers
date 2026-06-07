/**
 * Configuration for {@link createHostMeta}: the WebFinger endpoint URL that
 * seeds the `lrdd` template and/or a set of static top-level links, plus the
 * optional logging/metrics seams. Per the composition contract the package
 * never reads the global environment — every link arrives here, so a handler
 * can be instantiated multiple times and tested in isolation.
 */

import { noopLogger, noopMetrics, type Logger, type Metrics } from "@dwk/log";
import type { Link } from "@dwk/webfinger";

import { buildDocument, type HostMetaDocument } from "./document";
import { serializeJrd } from "./jrd";
import { serializeXrd } from "./xrd";

/** Configuration passed to {@link createHostMeta}. */
export interface HostMetaConfig {
  /**
   * The site's WebFinger endpoint URL (e.g.
   * `https://example.com/.well-known/webfinger`). When supplied, an `lrdd` link
   * templated to it (`…?resource={uri}`) is emitted first — the relation
   * fediverse/OpenID software fetches host-meta to find before falling back to
   * WebFinger. A URL already containing `{uri}` is used verbatim.
   */
  readonly webfingerUrl?: string;
  /**
   * Additional static top-level `Link` entries to advertise (e.g. `author`,
   * `license`). Appended after the auto-generated `lrdd` link. At least one of
   * {@link webfingerUrl} or `links` MUST be supplied, or {@link createHostMeta}
   * throws at construction time.
   */
  readonly links?: readonly Link[];
  /** Optional subject the metadata describes — the host itself (XRD `Subject`). */
  readonly subject?: string;
  /** Optional host-level properties; a `null` value means "present but absent". */
  readonly properties?: Readonly<Record<string, string | null>>;
  /**
   * Logger for discovery events; defaults to a no-op. Wire a real logger (see
   * `@dwk/log`) to surface which representation was served and why a request was
   * rejected instead of swallowing them.
   */
  readonly logger?: Logger;
  /**
   * Metrics sink for discovery counters; defaults to a no-op. Wire an adapter
   * (e.g. `analyticsEngineMetrics` from `@dwk/log`) to chart the same events the
   * logger names — "served/min" by format, "rejection rate".
   */
  readonly metrics?: Metrics;
}

/** Configuration after defaults are filled and the document is pre-computed. */
export interface ResolvedConfig {
  /** The host-meta document, built once at construction (it never varies per request). */
  readonly document: HostMetaDocument;
  /** The XRD representation, serialized once at construction. */
  readonly xrdBody: string;
  /** The JRD representation, serialized once at construction. */
  readonly jrdBody: string;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/**
 * Validate and normalise a {@link HostMetaConfig}. Fails loudly when neither a
 * WebFinger URL nor any static link is configured — a host-meta document that
 * advertises nothing is always a misconfiguration, not a silently empty `XRD`.
 * The document is computed once here (it is request-invariant) and reused for
 * every response.
 */
export function resolveConfig(config: HostMetaConfig): ResolvedConfig {
  const hasLinks = (config.links?.length ?? 0) > 0;
  if (config.webfingerUrl === undefined && !hasLinks) {
    throw new Error(
      "@dwk/host-meta: configure `webfingerUrl` and/or `links` — a host-meta " +
        "document must advertise at least one link.",
    );
  }

  // The document is request-invariant, so both representations are serialized
  // once here and reused verbatim for every response — no per-request XML
  // serialization or JSON.stringify.
  const document = buildDocument({
    webfingerUrl: config.webfingerUrl,
    links: config.links,
    subject: config.subject,
    properties: config.properties,
  });

  return {
    document,
    xrdBody: serializeXrd(document),
    jrdBody: serializeJrd(document),
    logger: config.logger ?? noopLogger,
    metrics: config.metrics ?? noopMetrics,
  };
}
