/**
 * `@dwk/store` — DO-SQLite quad store + R2 copy-on-write blob bodies behind one
 * storage-agnostic interface.
 *
 * Confines Cloudflare storage specifics here so the pure libs (`@dwk/wac`,
 * `@dwk/rdf`, `@dwk/dpop`) stay runtime-free. Authoritative state lives only in
 * DO SQLite and R2 — never KV. Blob bodies are content-addressed and
 * copy-on-write; orphaned keys are reported transactionally at delete time and
 * reclaimed by an out-of-band GC Worker that never sweeps Durable Objects.
 *
 * @see spec/packages/store.md
 */

export {
  createStore,
  PreconditionFailedError,
  DEFAULT_MAX_INLINE_BYTES,
  type Store,
  type StoreEnv,
  type StoreConfig,
  type StorageTier,
  type ResourceMeta,
  type BlobBody,
  type BlobBodyInit,
  type QuadPatch,
  type WriteOptions,
  type DeleteOptions,
  type OrphanRecord,
  type OrphanCancelRecord,
} from "./store.js";

export {
  collectGarbage,
  forwardOrphans,
  d1OrphanSink,
  ensureGcSchema,
  GC_SCHEMA,
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_FORWARDED_RETENTION_MS,
  type OrphanSink,
  type GcEnv,
} from "./gc.js";

export type { ResourceKind } from "./sql.js";
