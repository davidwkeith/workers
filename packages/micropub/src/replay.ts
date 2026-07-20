/**
 * Strongly-consistent, short-TTL record of accepted DPoP proof `jti`s, so a
 * captured proof cannot be replayed within its acceptance window to repeat a
 * state-changing request. `@dwk/dpop` verifies a proof's freshness but, per
 * RFC 9449, delegates replay detection to the caller via the returned `jti`;
 * this is that caller-side record.
 *
 * The table lives in D1 (the strongly-consistent `MICROPUB_DB`) — never KV,
 * where ~60 s of staleness would let a replayed proof slip through (see
 * `spec/non-functional-requirements.md`). Rows are reaped once their proof can
 * no longer be cryptographically accepted, so the table only ever tracks the
 * live window.
 */

import type { MicropubStoreEnv } from "./store.js";

/** Storage interface over accepted DPoP proof `jti`s. */
export interface DpopReplayStore {
  /** Create the schema if absent. Idempotent. */
  init(): Promise<void>;
  /**
   * Atomically record an accepted proof `jti`. Returns `true` when the `jti`
   * was unseen (and is now recorded), or `false` when it was already present —
   * i.e. a replay. `expiresAt`/`now` are seconds since the epoch.
   */
  recordProof(jti: string, expiresAt: number, now: number): Promise<boolean>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS dpop_proofs (
   jti TEXT PRIMARY KEY,
   expires_at INTEGER NOT NULL
 )`;

/**
 * Create the D1-backed {@link DpopReplayStore}. Fails loudly if the required
 * `MICROPUB_DB` binding is missing — no silent degradation (composition
 * contract); silently skipping replay detection would be a security bug.
 */
export function createDpopReplayStore(env: MicropubStoreEnv): DpopReplayStore {
  if (!env.MICROPUB_DB) {
    throw new Error("@dwk/micropub: missing required D1 binding `MICROPUB_DB`");
  }
  const db = env.MICROPUB_DB;

  // Create the schema lazily on first use so a consumer that composes the
  // package against a fresh D1 never needs a separate migration step: the first
  // authenticated request that records a proof materialises the table. Mirrors
  // the lazy-schema pattern the webmention/websub/microsub stores use. The
  // cached promise is cleared on failure so a transient D1 error during the
  // first call doesn't permanently wedge the store.
  let ready: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    ready ??= db
      .prepare(SCHEMA)
      .run()
      .then(() => undefined)
      .catch((err: unknown) => {
        ready = null;
        throw err;
      });
    return ready;
  };

  return {
    async init() {
      await ensureSchema();
    },

    async recordProof(jti, expiresAt, now) {
      await ensureSchema();
      // Reap-then-record in a single batched transaction (one D1 roundtrip):
      //   1. DELETE rows whose proof can no longer be accepted, so the table
      //      tracks only the live window.
      //   2. INSERT OR IGNORE this `jti`; `meta.changes` tells us whether it was
      //      unseen. A `jti` is a per-proof random UUID, so a row that survives
      //      reaping and collides is a genuine replay, not a stale entry.
      const results = await db.batch([
        db.prepare("DELETE FROM dpop_proofs WHERE expires_at <= ?").bind(now),
        db
          .prepare(
            "INSERT OR IGNORE INTO dpop_proofs (jti, expires_at) VALUES (?, ?)",
          )
          .bind(jti, expiresAt),
      ]);
      // The INSERT is the second statement; `meta.changes` is 0 on a replay.
      return (results[1]?.meta.changes ?? 0) > 0;
    },
  };
}
