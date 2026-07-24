/**
 * `createCentralDurableObjectNamespace` — the `central` storage mode's Tier 2
 * (actor) counterpart to a bare `@dwk/deno-host` `createDurableObjectNamespace`
 * call: composes it with the sync-before-serve rule baked in, so a composing
 * deployer cannot forget it.
 *
 * Per [spec/scale-out.md §6.2](../../../spec/scale-out.md#62-sqlstorage-per-object-libsql-database-embedded-replica),
 * a different replica may have written to an object id's database since this
 * replica last held its lease — the embedded replica **MUST** be synced from
 * the primary after acquiring the lease and before the event runs, or reads
 * are stale (a correctness bug, not an optimization). `@dwk/deno-host`'s
 * namespace exposes the timing hook this needs
 * (`DurableObjectNamespaceOptions.onLeaseAcquired`, added for this issue — see
 * `spec/packages/deno-host.md` "Design: sync-before-serve hook (issue #432)")
 * but does not call any particular sync method itself, since it takes no
 * dependency on what a storage client's sync capability looks like. This
 * module is where `@dwk/server` closes that gap for its own embedded-replica
 * client shape: every dispatch calls `client.sync()` unconditionally, so the
 * rule is structural rather than something a deployer has to remember to wire
 * up per namespace.
 *
 * `@dwk/server` never constructs an embedded-replica connection itself — like
 * every other `central`-mode seam (`central-bindings.ts`'s D1/R2, `LibsqlKv`'s
 * coordination store), the deployer injects `getStorageClient`, typically
 * backed by the `libsql` npm package's synchronous embedded-replica client
 * (`new Database(path, { syncUrl, authToken })`; see `libsql-native.smoke.test.ts`
 * for a Node-native-module load check, and `central-test-harness.ts` for the
 * fake this package's own tests drive instead).
 *
 * The endpoint packages that ship a Durable Object (`solid-pod`, `activitypub`,
 * `remotestorage`, `webauthn`, `atproto-pds`) import their `DurableObject` base
 * class from the `cloudflare:workers` bare specifier, resolved for this host to
 * `@dwk/cf-shims`'s shim (via `registerCloudflareWorkers`/the vitest alias) —
 * unchanged for central mode. That base class only wires `ctx`/`env` fields in
 * its constructor, so which concrete `DurableObject` class a package's `extends`
 * clause resolved to at import time is irrelevant at runtime: constructing the
 * exact same class through *this* module's namespace (whose `ctx`/`env` are
 * `@dwk/deno-host`'s structurally-compatible `DenoDurableObjectState`/
 * `DenoDurableObjectStorage`) works unmodified. No second loader hook is
 * needed for central mode.
 *
 * @see spec/scale-out.md §6 (issue #432)
 */

import {
  createDurableObjectNamespace,
  type DenoKvLike,
  type DurableObjectClass,
  type DurableObjectNamespaceLike,
  type SyncSqliteDatabaseLike,
} from "@dwk/deno-host";
import { noopLogger, type Logger } from "@dwk/log";

/**
 * The synchronous embedded-replica client shape central-mode DO storage
 * needs: `SyncSqliteDatabaseLike` (host-contract §3.2) plus a `sync()` method
 * pulling this replica's local file up to date from its primary. The `libsql`
 * npm package's embedded-replica `Database` satisfies this unmodified. Not
 * part of `@dwk/deno-host`'s own `SyncSqliteDatabaseLike` seam — only the host
 * that actually constructs embedded-replica clients needs to know about
 * `sync()`.
 */
export interface EmbeddedReplicaClientLike extends SyncSqliteDatabaseLike {
  sync(): Promise<void>;
}

/** Options for {@link createCentralDurableObjectNamespace}. */
export interface CentralDurableObjectNamespaceOptions<Env> {
  /** The coordination store backing the per-id lease and alarm schedule. */
  readonly kv: DenoKvLike;
  readonly className: string;
  readonly env: Env;
  /**
   * Opens (or returns the process-cached) embedded-replica client for an
   * object id. Called once per id, same caching contract as
   * `@dwk/deno-host`'s own `getStorageClient` (which this wraps).
   */
  readonly getStorageClient: (idHex: string) => EmbeddedReplicaClientLike;
  readonly leaseTtlMs?: number;
  readonly leaseAcquireTimeoutMs?: number;
  /** Observability (spec/scale-out.md §12, #433): logs `central_do.sync_duration_ms`/`central_do.sync_error`. Defaults to a no-op. */
  readonly logger?: Logger;
}

/**
 * Build a central-mode Durable Object namespace: `@dwk/deno-host`'s
 * `createDurableObjectNamespace`, with `client.sync()` wired to run on every
 * dispatch after the lease is acquired and before the event executes (the
 * sync-before-serve rule, non-optional). Place the returned value into the
 * host `Env` exactly as the local-mode `createDurableObjectNamespace` from
 * `@dwk/cf-shims` is today (e.g. `env.ACTOR = createCentralDurableObjectNamespace(...)`).
 */
export function createCentralDurableObjectNamespace<
  Env,
  T extends { fetch(r: Request): Promise<Response> },
>(
  ctor: DurableObjectClass<T>,
  options: CentralDurableObjectNamespaceOptions<Env>,
): DurableObjectNamespaceLike<T> {
  const logger = options.logger ?? noopLogger;
  return createDurableObjectNamespace<Env, T>(ctor, {
    kv: options.kv,
    className: options.className,
    env: options.env,
    getStorageClient: options.getStorageClient,
    leaseTtlMs: options.leaseTtlMs,
    leaseAcquireTimeoutMs: options.leaseAcquireTimeoutMs,
    onLeaseAcquired: async (idHex, client) => {
      const startedAt = Date.now();
      try {
        await (client as EmbeddedReplicaClientLike).sync();
        logger.debug("central_do.sync_duration_ms", {
          className: options.className,
          idHex,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        logger.warn("central_do.sync_error", {
          className: options.className,
          idHex,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  });
}
