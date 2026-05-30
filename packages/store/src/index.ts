/**
 * `@dwk/store` — DO-SQLite quad store + R2 copy-on-write blob bodies behind one
 * storage-agnostic interface.
 *
 * Confines Cloudflare storage specifics here so the pure libs (`@dwk/wac`,
 * `@dwk/rdf`, `@dwk/dpop`) stay runtime-free. Authoritative state lives only in
 * DO SQLite and R2 — never KV. See `spec/packages/store.md`.
 */

/** Cloudflare bindings required to construct a {@link Store}. */
export interface StoreEnv {
  /** R2 bucket holding blob bodies. */
  readonly BLOBS: R2Bucket;
}

/** Storage interface over the DO-SQLite quad store and R2 blob bodies. */
export interface Store {
  /** Read the blob body at `key`, streamed from R2 (never fully buffered). */
  readBlob(key: string): Promise<ReadableStream | null>;
}

/**
 * Create a {@link Store} backed by a Durable Object's SQLite storage and an R2
 * bucket.
 *
 * @throws not implemented yet.
 */
export function createStore(_state: DurableObjectState, _env: StoreEnv): Store {
  throw new Error("@dwk/store: createStore is not implemented yet");
}
