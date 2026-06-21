/**
 * `@dwk/webmention` — inbox store.
 *
 * Verified mentions are persisted to an inbox so they can be surfaced on the
 * target resource. The default is a D1-backed store (strongly consistent —
 * never KV, per `spec/non-functional-requirements.md`); when composed into a
 * Solid Pod, a caller can supply an {@link InboxStore} backed by the
 * `@dwk/solid-pod` Durable Object instead. The store keys on the
 * `(source, target)` pair so re-verifying a mention updates it in place and a
 * source that drops the link can be removed. See `spec/packages/webmention.md`.
 *
 * @packageDocumentation
 */

import type { D1Database } from "@cloudflare/workers-types";

import { isRsvpValue, type RsvpValue } from "./rsvp.js";

/** A verified Webmention: `source` links to `target`, confirmed at `verifiedAt`. */
export interface VerifiedMention {
  readonly source: string;
  readonly target: string;
  /** Verification time, epoch milliseconds. */
  readonly verifiedAt: number;
  /**
   * The Indie RSVP value when this mention is an RSVP to the target; omitted for
   * an ordinary mention. Lets a consumer surface attendee state on the event.
   */
  readonly rsvp?: RsvpValue;
}

/** Persistence surface for verified mentions. */
export interface InboxStore {
  /** Upsert a verified mention, keyed on `(source, target)`. */
  store(mention: VerifiedMention): Promise<void>;
  /** Remove a mention (e.g. the source dropped the link); no-op when absent. */
  remove(source: string, target: string): Promise<void>;
  /** List mentions, newest first; scoped to `target` when given. */
  list(target?: string): Promise<VerifiedMention[]>;
}

/** Options for {@link createD1Inbox}. */
export interface D1InboxOptions {
  /** Table name to use; created if absent. Defaults to `webmentions`. */
  readonly table?: string;
}

interface MentionRow {
  readonly source: string;
  readonly target: string;
  readonly verified_at: number;
  readonly rsvp: string | null;
}

/**
 * Build a D1-backed {@link InboxStore}. The backing table is created on first
 * use if it does not already exist.
 */
export function createD1Inbox(
  db: D1Database,
  options?: D1InboxOptions,
): InboxStore {
  const table = options?.table ?? "webmentions";
  // Guard the identifier: it is interpolated into DDL, so only allow a safe
  // set of characters rather than trusting the caller blindly.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`@dwk/webmention: invalid inbox table name "${table}".`);
  }

  let ready: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    ready ??= db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${table} (` +
          `source TEXT NOT NULL, ` +
          `target TEXT NOT NULL, ` +
          `verified_at INTEGER NOT NULL, ` +
          `rsvp TEXT, ` +
          `PRIMARY KEY (source, target))`,
      )
      .run()
      // Add the `rsvp` column to inboxes created before RSVP support existed.
      // A fresh table already has it, so the duplicate-column error is expected
      // and swallowed; an older table gains the column.
      .then(() =>
        db
          .prepare(`ALTER TABLE ${table} ADD COLUMN rsvp TEXT`)
          .run()
          .catch(() => undefined),
      )
      .then(() => undefined);
    return ready;
  };

  return {
    async store(mention) {
      await ensureSchema();
      await db
        .prepare(
          `INSERT INTO ${table} (source, target, verified_at, rsvp) ` +
            `VALUES (?1, ?2, ?3, ?4) ` +
            `ON CONFLICT (source, target) ` +
            `DO UPDATE SET verified_at = excluded.verified_at, ` +
            `rsvp = excluded.rsvp`,
        )
        .bind(
          mention.source,
          mention.target,
          mention.verifiedAt,
          mention.rsvp ?? null,
        )
        .run();
    },

    async remove(source, target) {
      await ensureSchema();
      await db
        .prepare(`DELETE FROM ${table} WHERE source = ?1 AND target = ?2`)
        .bind(source, target)
        .run();
    },

    async list(target) {
      await ensureSchema();
      const statement =
        target === undefined
          ? db.prepare(
              `SELECT source, target, verified_at, rsvp FROM ${table} ` +
                `ORDER BY verified_at DESC`,
            )
          : db
              .prepare(
                `SELECT source, target, verified_at, rsvp FROM ${table} ` +
                  `WHERE target = ?1 ORDER BY verified_at DESC`,
              )
              .bind(target);
      const { results } = await statement.all<MentionRow>();
      return results.map((row) => ({
        source: row.source,
        target: row.target,
        verifiedAt: row.verified_at,
        ...(row.rsvp !== null && isRsvpValue(row.rsvp)
          ? { rsvp: row.rsvp }
          : {}),
      }));
    },
  };
}
