/**
 * `@dwk/webmention` — sent-mention log.
 *
 * The sender is stateless per call, but Webmention §3.1.5 (a SHOULD) asks the
 * publisher to re-send its Webmentions when a previously-published source is
 * later deleted, so each receiver re-fetches the source, sees the `410 Gone`
 * (or `404`), and drops the stored mention. Re-sending requires remembering
 * who was notified: this module is that memory — an opt-in log of
 * `(source, target)` pairs whose notification was accepted, written by the
 * sender when a {@link SentLog} is supplied, and replayed by
 * `resendForDeletedSource` after the source is gone. The default is a
 * D1-backed log (strongly consistent — never KV, per
 * `spec/non-functional-requirements.md`), sharing the receiver's D1 binding
 * but its own table. See `spec/packages/webmention.md`.
 *
 * @packageDocumentation
 */

import type { D1Database } from "@cloudflare/workers-types";

/** Persistence surface for the sender's delivered-notification log. */
export interface SentLog {
  /** Upsert a delivered notification, keyed on `(source, target)`. */
  record(source: string, target: string, sentAt: number): Promise<void>;
  /** Targets previously notified for `source`, oldest first. */
  listTargets(source: string): Promise<string[]>;
  /** Drop one `(source, target)` pair; no-op when absent. */
  remove(source: string, target: string): Promise<void>;
}

/** Options for {@link createD1SentLog}. */
export interface D1SentLogOptions {
  /** Table name to use; created if absent. Defaults to `webmentions_sent`. */
  readonly table?: string;
}

/**
 * Build a D1-backed {@link SentLog}. The backing table is created on first
 * use if it does not already exist.
 */
export function createD1SentLog(
  db: D1Database,
  options?: D1SentLogOptions,
): SentLog {
  const table = options?.table ?? "webmentions_sent";
  // Guard the identifier: it is interpolated into DDL, so only allow a safe
  // set of characters rather than trusting the caller blindly.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`@dwk/webmention: invalid sent-log table name "${table}".`);
  }

  let ready: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    ready ??= db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${table} (` +
          `source TEXT NOT NULL, ` +
          `target TEXT NOT NULL, ` +
          `sent_at INTEGER NOT NULL, ` +
          `PRIMARY KEY (source, target))`,
      )
      .run()
      .then(() => {});
    return ready;
  };

  return {
    async record(source, target, sentAt) {
      await ensureSchema();
      await db
        .prepare(
          `INSERT INTO ${table} (source, target, sent_at) ` +
            `VALUES (?1, ?2, ?3) ` +
            `ON CONFLICT (source, target) DO UPDATE SET sent_at = excluded.sent_at`,
        )
        .bind(source, target, sentAt)
        .run();
    },

    async listTargets(source) {
      await ensureSchema();
      const { results } = await db
        .prepare(
          `SELECT target FROM ${table} WHERE source = ?1 ` +
            `ORDER BY sent_at ASC, target ASC`,
        )
        .bind(source)
        .all<{ target: string }>();
      return results.map((row) => row.target);
    },

    async remove(source, target) {
      await ensureSchema();
      await db
        .prepare(`DELETE FROM ${table} WHERE source = ?1 AND target = ?2`)
        .bind(source, target)
        .run();
    },
  };
}
