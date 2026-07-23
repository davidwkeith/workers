/**
 * `@dwk/cf-shims` — Node-backed implementations of the Cloudflare binding
 * interfaces: the reference implementation of the host contract
 * (`spec/host-contract.md`).
 *
 * Each shim implements the same TypeScript interface the `@dwk` endpoint
 * packages already program against — D1 and DO-SQLite on `node:sqlite`, R2 on
 * the filesystem (streaming, etag'd, metadata sidecars), KV on SQLite, a
 * durable SQLite-backed queue broker, a cron scheduler, and the Durable Object
 * lifecycle (per-id single-writer mutex, transactional `SqlStorage`, durable
 * alarms with retry, hibernation-style WebSockets) — so the packages run
 * unchanged. Alongside the bindings it ships the `cloudflare:workers` module
 * stand-in (plus a `module.register` loader hook that resolves the bare
 * specifier to it) and the idempotent runtime polyfill installers for
 * `HTMLRewriter`, `crypto.DigestStream`, and the `WebSocketPair` /
 * 101-`webSocket` `Response` globals.
 *
 * The package imports Node built-ins only (`node:sqlite`, `node:fs`,
 * `node:crypto`, `node:stream`, `node:module`) — no Express, no host-runtime
 * imports — so any Node-shaped host (`@dwk/server`, a bare `node:http` server,
 * a test harness, a future Deno host via `node:` compat) can consume it. The
 * single-writer-per-data-directory invariant is the consuming host's to
 * enforce (see `@dwk/server`'s startup lockfile).
 *
 * @see spec/host-contract.md
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
export {
  installWebSocketGlobals,
  responseWebSocket,
  EmulatedWebSocket,
  WebSocketPair,
} from "./web-socket.js";
