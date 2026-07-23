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
 * confines the *Node runtime and the Cloudflare-interface emulation* so the 20+
 * endpoint packages run **unchanged**. The shims live behind a clean,
 * Express-free boundary (`./shims`) so a later `@dwk/cf-shims` extraction is
 * mechanical. Single-process / single-writer per data directory is a load-bearing
 * invariant, enforced by a startup lockfile.
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

export { installHTMLRewriter } from "./html-rewriter.js";

export { installRequestDuplex } from "./request-duplex.js";

export { installWebSocketGlobals, WebSocketPair } from "./web-socket.js";

export {
  acquireWriterLock,
  DataDirectoryLockedError,
  type ReleaseLock,
} from "./lock.js";

export {
  createD1Database,
  createR2Bucket,
  createKVNamespace,
  QueueBroker,
  CronScheduler,
  DurableObject,
  createDurableObjectNamespace,
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
} from "./shims/index.js";

export {
  resolve,
  registerCloudflareWorkers,
} from "./cloudflare-workers-loader.js";
