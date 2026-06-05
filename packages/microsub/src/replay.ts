/**
 * Strongly-consistent, short-TTL record of accepted DPoP proof `jti`s, so a
 * captured proof cannot be replayed within its acceptance window to repeat a
 * state-changing request. `@dwk/dpop` verifies a proof's freshness but, per
 * RFC 9449, delegates replay detection to the caller via the returned `jti`;
 * this is that caller-side record.
 *
 * The table lives in D1 (the strongly-consistent `MICROSUB_DB`) — never KV,
 * where ~60 s of staleness would let a replayed proof slip through (see
 * `spec/non-functional-requirements.md`). Rows are reaped once their proof can
 * no longer be cryptographically accepted, so the table only ever tracks the
 * live window.
 *
 * @packageDocumentation
 */

import type { MicrosubStoreEnv } from "./store";

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

const SCHEMA = `CREATE TABLE IF NOT EXISTS microsub_dpop_proofs (
   jti TEXT PRIMARY KEY,
   expires_at INTEGER NOT NULL
 )`;

/**
 * Create the D1-backed {@link DpopReplayStore}. Fails loudly if the required
 * `MICROSUB_DB` binding is missing — no silent degradation (composition
 * contract); silently skipping replay detection would be a security bug.
 */
export function createDpopReplayStore(env: MicrosubStoreEnv): DpopReplayStore {
  if (!env.MICROSUB_DB) {
    throw new Error("@dwk/microsub: missing required D1 binding `MICROSUB_DB`");
  }
  const db = env.MICROSUB_DB;

  return {
    async init() {
      await db.prepare(SCHEMA).run();
    },

    async recordProof(jti, expiresAt, now) {
      const results = await db.batch([
        db.prepare(SCHEMA),
        db
          .prepare("DELETE FROM microsub_dpop_proofs WHERE expires_at <= ?")
          .bind(now),
        db
          .prepare(
            "INSERT OR IGNORE INTO microsub_dpop_proofs (jti, expires_at) VALUES (?, ?)",
          )
          .bind(jti, expiresAt),
      ]);
      // The INSERT is the third statement; `meta.changes` is 0 on a replay.
      return (results[2]?.meta.changes ?? 0) > 0;
    },
  };
}
