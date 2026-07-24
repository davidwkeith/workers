/**
 * `@dwk/microsub` — a [Microsub](https://indieweb.org/Microsub-spec) server: the
 * IndieWeb **read side**.
 *
 * Endpoint package: exports a factory returning a `fetch`-compatible handler,
 * mountable under a path prefix so it composes with other `@dwk` packages in one
 * Worker. It manages feed **subscriptions** organised into **channels**, polls
 * and parses sources server-side (Atom / RSS / JSON Feed / `h-feed`), and serves
 * a normalised **JF2** timeline to reader clients (Monocle, Together,
 * Indigenous) — keeping the user's reading state on infrastructure they own.
 *
 * It consumes the DPoP-bound IndieAuth access tokens issued by `@dwk/indieauth`
 * (same authorization as `@dwk/micropub`), so a token minted for a different
 * `me` cannot read here. Subscriptions, timeline, and read-state live in D1 — a
 * strongly-consistent store, never KV. Polling runs off the read path on a
 * Cron-triggered queue; every outbound fetch is SSRF-guarded.
 *
 * @see spec/packages/microsub.md
 * @packageDocumentation
 */

export { createMicrosub } from "./handler.js";
export type { MicrosubHandler } from "./handler.js";

export { createMicrosubMcpTools } from "./mcp-tools.js";
export type { MicrosubMcpToolsConfig } from "./mcp-tools.js";

export { createMicrosubPoller } from "./poll.js";
export type { MicrosubScheduledHandler } from "./poll.js";

export { createMicrosubQueueConsumer } from "./consumer.js";
export type { MicrosubQueueConsumer, ConsumerOptions } from "./consumer.js";

export { resolveConfig } from "./config.js";
export type { MicrosubConfig, MicrosubEnv, ResolvedConfig } from "./config.js";

export {
  createMicrosubStore,
  NOTIFICATIONS_CHANNEL,
  type MicrosubStore,
  type MicrosubStoreEnv,
  type ChannelRecord,
  type FollowRecord,
  type StoredItem,
  type ItemPage,
  type ListOptions,
  type FeedCache,
} from "./store.js";

export {
  authorize,
  tokenFromHeader,
  hasScope,
  type AuthEnv,
  type AuthResult,
  type AuthSuccess,
  type AuthFailure,
} from "./auth.js";

export {
  parseFeed,
  type Jf2Entry,
  type Jf2Author,
  type Jf2Content,
} from "./jf2.js";

export { parseHFeed } from "@dwk/mf2";

export {
  discoverFeed,
  fetchFeed,
  type DiscoveredFeed,
  type FetchedFeed,
  type DiscoveryOptions,
} from "./discovery.js";

export {
  safeFetch,
  assertPublicUrl,
  isPrivateOrReservedHost,
  SsrfError,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
  type SafeFetchOptions,
  type SafeFetchResult,
  type SsrfReason,
} from "@dwk/safe-fetch";
export type { MicrosubJob, PollJob } from "./queue.js";

export { MicrosubLogEvent } from "./log.js";
export type { Logger, Metrics } from "@dwk/log";
