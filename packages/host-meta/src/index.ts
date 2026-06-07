/**
 * `@dwk/host-meta` — Web Host Metadata (RFC 6415) host-meta discovery endpoint.
 *
 * Endpoint package: exports a factory returning a `fetch`-compatible handler,
 * mountable at `/.well-known/host-meta` and `/.well-known/host-meta.json` so it
 * composes with other `@dwk` packages in one Worker. It serves one host-wide
 * resource-discovery document — a set of top-level `Link`s, at minimum an
 * `lrdd` template pointing at the site's WebFinger endpoint — in either the XRD
 * (`application/xrd+xml`, the default) or JRD (`application/jrd+json`)
 * representation, chosen by content negotiation (RFC 6415 §3, RFC 7033 §10.1).
 *
 * It exists because host-meta is **borderline static**: a single-identity site
 * can emit fixed files, but only request logic can negotiate XRD ⇄ JRD from the
 * one URL and template a dynamic `lrdd` link. The package is pure and stateless
 * — the document is config-supplied (a WebFinger URL and/or static links),
 * never read from the global environment — so it ships no Durable Object and
 * needs no bindings, and the serializers unit-test under Node without a Workers
 * runtime. The XRD serializer is the only surface new to this package; the JRD
 * link shaping is reused from `@dwk/webfinger`.
 *
 * @see spec/packages/host-meta.md
 * @packageDocumentation
 */

export { createHostMeta } from "./handler";
export type { HostMetaEnv, HostMetaHandler } from "./handler";

export {
  resolveConfig,
  type HostMetaConfig,
  type ResolvedConfig,
} from "./config";

export {
  buildDocument,
  lrddTemplate,
  type HostMetaDocument,
  type Link,
} from "./document";

export { buildHostMetaJrd, serializeJrd, type HostMetaJrd } from "./jrd";

export { serializeXrd, escapeXml, XRD_NAMESPACE } from "./xrd";

export { negotiateFormat, type Format } from "./negotiation";

export { HostMetaLogEvent } from "./log";
export type { Logger, Metrics } from "@dwk/log";
