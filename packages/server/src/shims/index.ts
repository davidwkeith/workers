/**
 * Node-backed implementations of the Cloudflare binding interfaces.
 *
 * These live behind a clean, Express-free boundary (this module imports nothing
 * from the host runtime) so a later `@dwk/cf-shims` extraction — for test
 * harnesses or alternative Node HTTP frameworks — is mechanical. Each shim
 * implements the same TypeScript interface the endpoint packages already program
 * against, so the packages run unchanged.
 *
 * @see spec/self-hosting.md §7
 */

export { createD1Database } from "./d1";
export { createR2Bucket } from "./r2";
export { createKVNamespace, type KVOptions } from "./kv";
export {
  QueueBroker,
  type QueueBrokerOptions,
  type ConsumerOptions,
  type QueueConsumerHandler,
} from "./queue";
export {
  CronScheduler,
  type CronSchedulerOptions,
  type ScheduledHandler,
} from "./cron";
