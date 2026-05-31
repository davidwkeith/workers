/**
 * The out-of-band blob garbage-collection path.
 *
 * Orphaned R2 keys are reported by each pod's Durable Object *at delete time*
 * (the transactional outbox in `store.ts`), forwarded into one shared tracking
 * store (a D1 table), and reclaimed from R2 by a cron Worker after a safety
 * window ≥ the maximum write duration. Critically, {@link collectGarbage} reads
 * only D1 and R2 — it never scans or wakes a per-pod Durable Object, so GC cost
 * is bounded by the number of *pending orphans*, not the number of pods.
 */

import type { OrphanRecord, Store } from "./store";

/** Sink the per-pod outbox is drained into (the shared GC tracking store). */
export interface OrphanSink {
  enqueue(
    keys: readonly { blobKey: string; enqueuedAt: number }[],
  ): Promise<void>;
}

/** Bindings the cron GC Worker needs. */
export interface GcEnv {
  readonly BLOBS: R2Bucket;
  readonly GC_DB: D1Database;
}

/** D1 DDL for the shared orphan tracking table. */
export const GC_SCHEMA = `CREATE TABLE IF NOT EXISTS orphan_blobs (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     blob_key    TEXT NOT NULL,
     enqueued_at INTEGER NOT NULL
   )`;

/** Create the shared orphan tracking table if it does not exist. */
export async function ensureGcSchema(db: D1Database): Promise<void> {
  await db.exec(GC_SCHEMA.replace(/\s+/g, " ").trim());
}

/** An {@link OrphanSink} backed by the shared D1 `orphan_blobs` table. */
export function d1OrphanSink(db: D1Database): OrphanSink {
  return {
    async enqueue(keys) {
      if (keys.length === 0) return;
      const insert = db.prepare(
        "INSERT INTO orphan_blobs (blob_key, enqueued_at) VALUES (?, ?)",
      );
      await db.batch(keys.map((k) => insert.bind(k.blobKey, k.enqueuedAt)));
    },
  };
}

/**
 * Drain a pod's transactional outbox into the shared sink: read pending rows,
 * forward them, then remove the forwarded rows. Returns the number forwarded.
 *
 * Forwarding is at-least-once: rows are only removed from the outbox after the
 * sink accepts them, so a crash mid-drain re-forwards rather than loses a key
 * (a duplicate key is harmless — GC deletes an absent object idempotently).
 */
export async function forwardOrphans(
  store: Store,
  sink: OrphanSink,
  options: { limit?: number } = {},
): Promise<number> {
  const pending: OrphanRecord[] = store.collectOrphans(options.limit);
  if (pending.length === 0) return 0;
  await sink.enqueue(
    pending.map((o) => ({ blobKey: o.blobKey, enqueuedAt: o.enqueuedAt })),
  );
  store.removeForwardedOrphans(pending.map((o) => o.id));
  return pending.length;
}

/**
 * Reclaim orphaned R2 objects whose tracking rows are older than the safety
 * window. Deletes the object then its tracking row, one at a time, and returns
 * the keys reclaimed. Touches only D1 and R2 — never a Durable Object.
 */
export async function collectGarbage(
  env: GcEnv,
  options: { now?: number; safetyWindowMs: number; limit?: number },
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const cutoff = now - options.safetyWindowMs;
  const limit = options.limit ?? 100;

  const { results } = await env.GC_DB.prepare(
    `SELECT id, blob_key FROM orphan_blobs
     WHERE enqueued_at <= ? ORDER BY enqueued_at LIMIT ?`,
  )
    .bind(cutoff, limit)
    .all<{ id: number; blob_key: string }>();

  const reclaimed: string[] = [];
  for (const row of results) {
    await env.BLOBS.delete(row.blob_key);
    await env.GC_DB.prepare("DELETE FROM orphan_blobs WHERE id = ?")
      .bind(row.id)
      .run();
    reclaimed.push(row.blob_key);
  }
  return reclaimed;
}
