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

export {
  createServer,
  createCentralServer,
  DwkServer,
  type CentralServerProbeTargets,
} from "./server.js";

export {
  resolveOrigin,
  assertBindings,
  isReservedPath,
  MissingBindingError,
  InsecureBaseUrlError,
  type HostConfig,
  type Mount,
  type FetchHandler,
  type StorageConfig,
  type CentralStorageConfig,
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
// queue machinery can span replicas. `HostConfig.storage` (central mode, #431)
// takes any `DenoKvLike` as its coordination store — a `LibsqlKv` instance is
// the intended one, injected by the deployer.
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

// Central storage mode (spec/scale-out.md §9, #431): the D1/R2/KV bindings
// assembly over `@dwk/deno-host`'s centralized-store shims, and the mode
// guard + startup probes that replace the local-writer lockfile's invariant
// for a fleet of stateless replicas.
export {
  assembleCentralBindings,
  type CentralBindingsSpec,
  type CentralR2BindingSpec,
} from "./central-bindings.js";

export {
  assertNoLocalStores,
  assertModeMarker,
  probeCentralStores,
  LocalStoreConflictError,
  ModeMarkerConflictError,
  StartupProbeError,
  type StartupProbeTargets,
  type StartupProbeFailure,
} from "./central-mode.js";

// Central-mode Durable Objects (Tier 2, spec/scale-out.md §6, #432): the
// namespace composition wrapper that bakes in the sync-before-serve rule.
export {
  createCentralDurableObjectNamespace,
  type CentralDurableObjectNamespaceOptions,
  type EmbeddedReplicaClientLike,
} from "./central-durable-object.js";

// The per-replica background tick every replica MUST run for central-mode
// alarms and queue messages to be delivered at all (spec/scale-out.md §6.3,
// §7.1, #432/#433) — `ns.pollAlarms()` and `broker.pollQueues()` need wired
// to something, and this is it.
export {
  CentralFleetPoller,
  type CentralFleetPollerOptions,
  type PollableDurableObjectNamespace,
  type PollableQueueBroker,
  type SweepableCoordinationStore,
} from "./central-fleet-poller.js";

// Central-mode cron (spec/scale-out.md §7.2, #433): the tick-lease-guarded
// scheduler every replica runs so a `scheduled` handler fires once fleet-wide
// per cadence bucket instead of once per replica.
export {
  CentralCronScheduler,
  type CentralCronSchedulerOptions,
} from "./central-cron.js";

// Central-mode health surfaces (spec/scale-out.md §12, #433): liveness +
// readiness `Mount`s a deployer adds to `HostConfig.mounts` alongside the
// endpoint packages.
export {
  createCentralHealthMounts,
  type CentralHealthOptions,
} from "./central-health.js";

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
