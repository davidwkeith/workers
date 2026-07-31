/**
 * `@dwk/cf-shims` — Node-backed implementations of the Cloudflare Workers
 * binding interfaces (`D1Database`, `R2Bucket`, `KVNamespace`, `Queue`,
 * `scheduled`/cron, Durable Objects) plus the runtime-global seams a Worker
 * gets for free and Node does not (`cloudflare:workers`'s `DurableObject`
 * base class, `HTMLRewriter`, `crypto.DigestStream`, hibernatable
 * `WebSocket`s).
 *
 * This is **not protocol-agnostic** — unlike `@dwk/rdf`/`@dwk/dpop`/etc., it
 * exists specifically to emulate Cloudflare's runtime surface on Node, so the
 * confinement principle here is the mirror image of theirs: Cloudflare
 * specifics are exactly what this package is for. What it does keep clean is
 * the **host boundary** — every export imports only Node built-ins
 * (`node:sqlite`, `node:fs`, `node:crypto`, `node:stream`) plus
 * `@worker-tools/html-rewriter`, never a host framework (no Express) — so any
 * Node host (a bare `node:http` server, a test harness, `@dwk/server`) can
 * compose it unchanged. Also included: `crypto.subtle.timingSafeEqual`, a
 * real but Cloudflare-Workers-proprietary `SubtleCrypto` extension several
 * endpoint packages rely on for constant-time comparisons.
 *
 * Extracted from `@dwk/server`'s internal `./shims` (see
 * [self-hosting.md §16](../../../spec/self-hosting.md#16-resolved-decisions)
 * decision 6 and [portability.md](../../../spec/portability.md)); `@dwk/server`
 * is now its first consumer, not its owner.
 *
 * @see spec/packages/cf-shims.md
 * @packageDocumentation
 */

export { createD1Database } from "./d1.js";
export { createR2Bucket } from "./r2.js";
export { createKVNamespace, type KVOptions } from "./kv.js";
export {
  QueueBroker,
  type QueueBrokerOptions,
  type ConsumerOptions,
  type QueueConsumerHandler,
} from "./queue.js";
export {
  CronScheduler,
  type CronSchedulerOptions,
  type ScheduledHandler,
} from "./cron.js";
export {
  DurableObject,
  createDurableObjectNamespace,
  type AlarmInvocationInfo,
  type DurableObjectClass,
  type DurableObjectNamespaceOptions,
  type DurableObjectState,
  type SqlStorage,
} from "./durable-object.js";

export {
  resolve,
  registerCloudflareWorkers,
} from "./cloudflare-workers-loader.js";

export { installHTMLRewriter } from "./html-rewriter.js";

export { installCryptoDigestStream } from "./crypto-digest-stream.js";

export { installTimingSafeEqual } from "./timing-safe-equal.js";

export {
  installWebSocketGlobals,
  WebSocketPair,
  EmulatedWebSocket,
  responseWebSocket,
} from "./web-socket.js";
