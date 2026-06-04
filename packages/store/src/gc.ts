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
  /**
   * Record orphaned keys. Deduplicated on `blobKey`: a key already tracked
   * keeps the **maximum** `enqueuedAt`, so re-forwarding (the outbox is
   * at-least-once) and re-orphaning never shorten a key's safety window.
   */
  enqueue(
    keys: readonly { blobKey: string; enqueuedAt: number }[],
  ): Promise<void>;
  /**
   * Cancel tracking rows for keys that were resurrected after forwarding, so
   * the cron GC never reclaims an object a live resource now points at.
   */
  cancel(blobKeys: readonly string[]): Promise<void>;
}

/** Bindings the cron GC Worker needs. */
export interface GcEnv {
  readonly BLOBS: R2Bucket;
  readonly GC_DB: D1Database;
}

/**
 * Default clock-skew margin for the timestamp resurrection heuristic. R2's
 * `uploaded` is second-resolution and can skew against a DO's `enqueued_at`, so
 * an object must be uploaded more than this margin *after* it was orphaned to be
 * treated as a live resurrection on timestamp alone. Data-loss safety does not
 * rest on this value — the version-conditional delete and the resurrection
 * cancel are the load-bearing guards; the margin only avoids leaking genuine
 * orphans whose `uploaded` skews slightly past their orphaning.
 */
export const DEFAULT_CLOCK_SKEW_MS = 5_000;

/**
 * Default retention for forwarded outbox rows. Must exceed the GC safety window
 * so a resurrection anywhere inside the window can still cancel its forwarded
 * tracking row before the cron GC reclaims it.
 */
export const DEFAULT_FORWARDED_RETENTION_MS = 60 * 60_000;

/**
 * D1 DDL for the shared orphan tracking table. `blob_key` is UNIQUE so inserts
 * dedup (keeping the max `enqueued_at`) and resurrection cancels delete by key.
 */
export const GC_SCHEMA = `CREATE TABLE IF NOT EXISTS orphan_blobs (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     blob_key    TEXT NOT NULL UNIQUE,
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
        `INSERT INTO orphan_blobs (blob_key, enqueued_at) VALUES (?, ?)
         ON CONFLICT(blob_key) DO UPDATE SET
           enqueued_at = MAX(orphan_blobs.enqueued_at, excluded.enqueued_at)`,
      );
      await db.batch(keys.map((k) => insert.bind(k.blobKey, k.enqueuedAt)));
    },
    async cancel(blobKeys) {
      if (blobKeys.length === 0) return;
      const del = db.prepare("DELETE FROM orphan_blobs WHERE blob_key = ?");
      await db.batch(blobKeys.map((k) => del.bind(k)));
    },
  };
}

/**
 * Drain a pod's transactional outbox into the shared sink: propagate
 * resurrection cancels, forward pending orphans, then prune aged-out forwarded
 * rows. Returns the number of orphans forwarded.
 *
 * Cancels are propagated **before** inserts so that a key re-orphaned after a
 * resurrection (a fresh outbox row plus a stale cancel) ends up tracked, not
 * deleted. Forwarding is at-least-once: a row is only marked forwarded after the
 * sink accepts it, so a crash mid-drain re-forwards rather than loses a key (the
 * dedup keeps this harmless). Forwarded rows are retained locally for
 * `retentionMs` so a later resurrection can still cancel them.
 */
export async function forwardOrphans(
  store: Store,
  sink: OrphanSink,
  options: { limit?: number; now?: number; retentionMs?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const retentionMs = options.retentionMs ?? DEFAULT_FORWARDED_RETENTION_MS;

  // 1. Propagate resurrection cancels first.
  const cancels = store.collectCancels(options.limit);
  if (cancels.length > 0) {
    await sink.cancel(cancels.map((c) => c.blobKey));
    store.removeForwardedCancels(cancels.map((c) => c.id));
  }

  // 2. Forward pending orphans, then mark (not delete) them forwarded.
  const pending: OrphanRecord[] = store.collectOrphans(options.limit);
  if (pending.length > 0) {
    await sink.enqueue(
      pending.map((o) => ({ blobKey: o.blobKey, enqueuedAt: o.enqueuedAt })),
    );
    store.markOrphansForwarded(
      pending.map((o) => o.id),
      now,
    );
  }

  // 3. Reclaim forwarded rows that have aged past the retention window.
  store.pruneForwardedOrphans(now - retentionMs);

  return pending.length;
}

/**
 * Reclaim orphaned R2 objects whose tracking rows are older than the safety
 * window. Deletes the object then its tracking row, one at a time, and returns
 * the keys reclaimed. Touches only D1 and R2 — never a Durable Object.
 *
 * Resurrection guards (keys are content-addressed, so re-uploading identical
 * content writes the same R2 key a live resource now points at):
 *
 * 1. **Timestamp:** skip a key whose object was uploaded more than
 *    `clockSkewMs` after it was orphaned — it was resurrected. The margin
 *    absorbs R2's second-resolution `uploaded` and DO↔R2 clock skew.
 * 2. **Version-conditional delete:** capture the object's `version` at `head`
 *    time and re-check it immediately before deleting; a resurrection landing in
 *    between gets a new version, so the delete is skipped rather than clobbering
 *    a live object. (R2 bindings expose no atomic conditional delete, so this
 *    head→delete recheck is the tightest guard available.)
 *
 * The tracking row is dropped either way; a resurrected key that is later
 * orphaned again is re-reported with a fresh row.
 */
export async function collectGarbage(
  env: GcEnv,
  options: {
    now?: number;
    safetyWindowMs: number;
    limit?: number;
    clockSkewMs?: number;
  },
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const cutoff = now - options.safetyWindowMs;
  const limit = options.limit ?? 100;
  const clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

  const { results } = await env.GC_DB.prepare(
    `SELECT id, blob_key, enqueued_at FROM orphan_blobs
     WHERE enqueued_at <= ? ORDER BY enqueued_at LIMIT ?`,
  )
    .bind(cutoff, limit)
    .all<{ id: number; blob_key: string; enqueued_at: number }>();

  const reclaimed: string[] = [];
  for (const row of results) {
    const head = await env.BLOBS.head(row.blob_key);
    const resurrected =
      head !== null && head.uploaded.getTime() > row.enqueued_at + clockSkewMs;
    if (head !== null && !resurrected) {
      // Version-conditional delete: re-`head` and bail if the version changed
      // (or the object vanished) since we inspected it — a resurrection in that
      // window must not be clobbered.
      const confirm = await env.BLOBS.head(row.blob_key);
      if (confirm !== null && confirm.version === head.version) {
        await env.BLOBS.delete(row.blob_key);
        reclaimed.push(row.blob_key);
      }
    }
    await env.GC_DB.prepare("DELETE FROM orphan_blobs WHERE id = ?")
      .bind(row.id)
      .run();
  }
  return reclaimed;
}
