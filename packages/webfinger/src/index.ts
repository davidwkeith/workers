/**
 * `@dwk/webfinger` — WebFinger (RFC 7033) account/resource discovery endpoint.
 *
 * Endpoint package: exports a factory returning a `fetch`-compatible handler,
 * mountable at `/.well-known/webfinger` so it composes with other `@dwk`
 * packages in one Worker. It maps a queried `resource` URI (`acct:`, `mailto:`,
 * `https:`) to a JSON Resource Descriptor (JRD) of links — avatar, profile page,
 * OIDC issuer, the `self` ActivityPub actor — and is the foundational discovery
 * step for federation.
 *
 * It exists because WebFinger is **borderline static**: a static host can emit a
 * single JRD, but only request logic can dispatch on `resource` (404 for a URI
 * this server does not control), echo the matched `subject`, and filter `links`
 * by `rel`. The package is pure and stateless — the `resource → JRD` mapping is
 * supplied by config (a static map and/or a resolver), never read from the
 * global environment — so it ships no Durable Object and needs no bindings, and
 * the discovery logic unit-tests under Node without a Workers runtime.
 *
 * @see spec/packages/webfinger.md
 * @packageDocumentation
 */

export { createWebfinger } from "./handler.js";
export type { WebfingerEnv, WebfingerHandler } from "./handler.js";

export {
  resolveConfig,
  type WebfingerConfig,
  type ResourceResolver,
  type ResolvedConfig,
} from "./config.js";

export {
  filterLinksByRel,
  buildJrd,
  type Jrd,
  type Link,
  type ResourceRecord,
} from "./jrd.js";

export { normalizeResource, isWellFormedResource } from "./resource.js";

export {
  parseHandle,
  webfingerQueryUrl,
  selectActorLink,
  resolveHandle,
  type ParsedHandle,
  type ResolveHandleOptions,
} from "./lookup.js";

export { WebfingerLogEvent } from "./log.js";
export type { Logger, Metrics } from "@dwk/log";
