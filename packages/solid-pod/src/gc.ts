/**
 * The R2 garbage-collection cron handler.
 *
 * Each pod's Durable Object forwards its orphaned blob keys (copy-on-write
 * displacements and deletes) into a shared D1 table as it writes. This handler
 * — wired to a Cloudflare cron trigger — reclaims those R2 objects once they
 * are older than a safety window ≥ the maximum write duration, touching only D1
 * and R2 and never waking a Durable Object. The reclamation logic lives in
 * `@dwk/store`; this is the thin endpoint wiring.
 */

import { collectGarbage, ensureGcSchema } from "@dwk/store";

import {
  resolveConfig,
  type SolidPodConfig,
  type SolidPodGcEnv,
} from "./config";

/** A `scheduled`-compatible cron handler for R2 blob garbage collection. */
export type SolidPodGcHandler = (
  event: ScheduledController,
  env: SolidPodGcEnv,
  ctx: ExecutionContext,
) => Promise<void>;

/**
 * Create the cron handler that reclaims orphaned R2 blobs. Bind it to a
 * `scheduled` trigger alongside the pod Worker; it shares the same `BLOBS`
 * bucket and the `GC_DB` D1 database the DO forwards orphans into.
 *
 * Fails loudly when the required `BLOBS` / `GC_DB` bindings are missing.
 */
export function createSolidPodGc(config: SolidPodConfig): SolidPodGcHandler {
  const resolved = resolveConfig(config);

  return async (_event, env, _ctx) => {
    if (!env.BLOBS) {
      throw new Error("@dwk/solid-pod: GC requires the `BLOBS` R2 binding");
    }
    if (!env.GC_DB) {
      throw new Error("@dwk/solid-pod: GC requires the `GC_DB` D1 binding");
    }
    await ensureGcSchema(env.GC_DB);
    await collectGarbage(env, { safetyWindowMs: resolved.gcSafetyWindowMs });
  };
}
