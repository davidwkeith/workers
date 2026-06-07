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

export { createServer, DwkServer } from "./server";

export {
  resolveOrigin,
  assertBindings,
  isReservedPath,
  MissingBindingError,
  InsecureBaseUrlError,
  type HostConfig,
  type Mount,
  type FetchHandler,
} from "./config";

export { toWebRequest, sendWebResponse } from "./adapter";

export { WaitUntilTracker, HostExecutionContext } from "./context";

export {
  acquireWriterLock,
  DataDirectoryLockedError,
  type ReleaseLock,
} from "./lock";

export {
  createD1Database,
  createR2Bucket,
  createKVNamespace,
  QueueBroker,
  CronScheduler,
  type KVOptions,
  type QueueBrokerOptions,
  type ConsumerOptions,
  type QueueConsumerHandler,
  type CronSchedulerOptions,
  type ScheduledHandler,
} from "./shims";
