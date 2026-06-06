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

export { createMicrosub } from "./handler";
export type { MicrosubHandler } from "./handler";

export { createMicrosubPoller } from "./poll";
export type { MicrosubScheduledHandler } from "./poll";

export { createMicrosubQueueConsumer } from "./consumer";
export type { MicrosubQueueConsumer, ConsumerOptions } from "./consumer";

export { resolveConfig } from "./config";
export type { MicrosubConfig, MicrosubEnv, ResolvedConfig } from "./config";

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
} from "./store";

export {
  authorize,
  tokenFromHeader,
  hasScope,
  type AuthEnv,
  type AuthResult,
  type AuthSuccess,
  type AuthFailure,
} from "./auth";

export {
  parseFeed,
  type Jf2Entry,
  type Jf2Author,
  type Jf2Content,
} from "./jf2";

export { parseHFeed } from "./hfeed";

export {
  discoverFeed,
  fetchFeed,
  type DiscoveredFeed,
  type FetchedFeed,
  type DiscoveryOptions,
} from "./discovery";

export {
  safeFetch,
  assertPublicUrl,
  isPrivateOrReservedHost,
  SsrfError,
  type SsrfReason,
} from "./safe-fetch";

export type { FetchLike } from "./fetch";
export type { MicrosubJob, PollJob } from "./queue";

export { MicrosubLogEvent } from "./log";
export type { Logger, Metrics } from "@dwk/log";
