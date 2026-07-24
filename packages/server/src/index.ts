/**
 * `@dwk/server` — Node.js/Express self-hosting host for the `@dwk` packages.
 *
 * Cloudflare Workers is the primary, recommended deployment target;
 * self-hosting is a supported secondary path (shipped as a Docker image). This
 * package is the Node analogue of "the Worker entry + `wrangler.toml`" a
 * Cloudflare deployer writes by hand: it composes the endpoint packages'
 * factories, bridges Express `(req, res)` ⇄ Web `Request`/`Response` (streaming
 * both ways), serves static files alongside the endpoints with deterministic
 * routing precedence, and constructs the `Env` from **Node-backed shims for the
 * Cloudflare binding interfaces** (D1 → `node:sqlite`, R2 → filesystem, KV →
 * SQLite, plus the in-process queue and cron lifecycle).
 *
 * It mirrors how `@dwk/store` confines Cloudflare *storage*: this package
 * confines the *Node runtime*, composing the Cloudflare-interface emulations
 * from `@dwk/cf-shims` behind Express, so the 20+ endpoint packages run
 * **unchanged**. Single-process / single-writer per data directory is a
 * load-bearing invariant, enforced by a startup lockfile.
 *
 * @see spec/self-hosting.md
 * @packageDocumentation
 */

export { createServer, DwkServer } from "./server.js";

export {
  resolveOrigin,
  assertBindings,
  isReservedPath,
  MissingBindingError,
  InsecureBaseUrlError,
  type HostConfig,
  type Mount,
  type FetchHandler,
} from "./config.js";

export { toWebRequest, sendWebResponse } from "./adapter.js";

export {
  assembleBindings,
  type BindingsSpec,
  type KvBindingSpec,
} from "./bindings.js";

export { WaitUntilTracker, HostExecutionContext } from "./context.js";

export {
  bindQueueConsumer,
  bindScheduledTask,
  type QueueHandler,
  type ScheduledTaskHandler,
} from "./lifecycle.js";

export { installRequestDuplex } from "./request-duplex.js";

// Scale-out coordination store (spec/scale-out.md §8, #428): @dwk/deno-host's
// `DenoKvLike` seam over a centralized libSQL database, so the lease/alarm/
// queue machinery can span replicas. Standalone for now — nothing in the
// local-storage host composes it yet.
export {
  LibsqlKv,
  encodeKvKey,
  decodeKvKey,
  type LibsqlKvOptions,
} from "./libsql-kv.js";

export {
  acquireWriterLock,
  DataDirectoryLockedError,
  type ReleaseLock,
} from "./lock.js";

// Re-exported from `@dwk/cf-shims`: the Node-backed Cloudflare binding shims
// and runtime-global seams this host composes behind Express. See that
// package for the implementations.
export {
  createD1Database,
  createR2Bucket,
  createKVNamespace,
  QueueBroker,
  CronScheduler,
  DurableObject,
  createDurableObjectNamespace,
  resolve,
  registerCloudflareWorkers,
  installHTMLRewriter,
  installCryptoDigestStream,
  installWebSocketGlobals,
  WebSocketPair,
  type KVOptions,
  type QueueBrokerOptions,
  type ConsumerOptions,
  type QueueConsumerHandler,
  type CronSchedulerOptions,
  type ScheduledHandler,
  type AlarmInvocationInfo,
  type DurableObjectClass,
  type DurableObjectNamespaceOptions,
  type DurableObjectState,
  type SqlStorage,
} from "@dwk/cf-shims";
