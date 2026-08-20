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
import { fnv1aBase36 } from "@dwk/mf2";

import {
  isInteractionType,
  type InteractionType,
  type MentionAuthor,
} from "./enrich.js";
import { isRsvpValue, type RsvpValue } from "./rsvp.js";

/**
 * The stable identifier for the mention keyed on `(source, target)`:
 * `wm-{hash}`, using the same FNV-1a/base36 hash `@dwk/mf2`'s JF2 layer uses
 * for its own fallback `_id`s. Deterministic, so it can be (re-)derived for
 * rows stored before the `id` column existed.
 */
export function mentionId(source: string, target: string): string {
  return `wm-${fnv1aBase36(`${source}\n${target}`)}`;
}

/** A verified Webmention: `source` links to `target`, confirmed at `verifiedAt`. */
export interface VerifiedMention {
  /**
   * Stable identifier derived from `(source, target)` — see {@link mentionId}.
   * Assigned by the store itself: always present on records returned from
   * `list()`, never required (and ignored) on `store()`.
   */
  readonly id?: string;
  readonly source: string;
  readonly target: string;
  /** Verification time, epoch milliseconds. */
  readonly verifiedAt: number;
  /**
   * How the source interacts with the target (reply/like/repost/bookmark, or
   * a plain mention). Optional on `store()` for backward compatibility —
   * absent means `"mention"` — and always present on records returned from
   * `list()`.
   */
  readonly interactionType?: InteractionType;
  /** The mentioning entry's author, when its mf2 declares one. */
  readonly author?: MentionAuthor;
  /** Sanitized HTML of the mentioning entry's content, when it has any. */
  readonly content?: string;
  /**
   * When the mentioning entry was published, epoch milliseconds. Falls back
   * to the verification time when the entry declares no `dt-published`, so
   * the field is always populated on records returned from `list()`.
   */
  readonly publishedAt?: number;
  /**
   * The Indie RSVP value when this mention is an RSVP to the target; omitted for
   * an ordinary mention. Lets a consumer surface attendee state on the event.
   */
  readonly rsvp?: RsvpValue;
  /**
   * The sender's Vouch URL (indieweb.org/Vouch) and whether it was confirmed
   * to link to the target's domain; omitted when no vouch was sent. A vouch
   * that was sent but did NOT check out is still recorded (`verified: false`)
   * — distinct from no vouch at all, since a failed vouch attempt is a
   * stronger spam signal than silence.
   */
  readonly vouch?: { readonly url: string; readonly verified: boolean };
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
  readonly id: string | null;
  readonly source: string;
  readonly target: string;
  readonly verified_at: number;
  readonly rsvp: string | null;
  readonly interaction_type: string | null;
  readonly author_name: string | null;
  readonly author_url: string | null;
  readonly author_photo: string | null;
  readonly content: string | null;
  readonly published_at: number | null;
  readonly vouch_url: string | null;
  readonly vouch_verified: number | null;
}

/**
 * Columns added after the table's original `(source, target, verified_at)`
 * shape, in the order they were introduced; inboxes created before a column
 * existed are migrated with an additive `ALTER TABLE`.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = [
  ["rsvp", "TEXT"],
  ["id", "TEXT"],
  ["interaction_type", "TEXT"],
  ["author_name", "TEXT"],
  ["author_url", "TEXT"],
  ["author_photo", "TEXT"],
  ["content", "TEXT"],
  ["published_at", "INTEGER"],
  ["vouch_url", "TEXT"],
  ["vouch_verified", "INTEGER"],
];

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
          ADDED_COLUMNS.map(([name, type]) => `${name} ${type}, `).join("") +
          `PRIMARY KEY (source, target))`,
      )
      .run()
      // Add later columns to inboxes created before they existed. `PRAGMA
      // table_info` is consulted first so a fresh table — already created
      // with the columns — skips the `ALTER`s rather than throwing a
      // swallowed duplicate-column error on every init.
      .then(async () => {
        const { results } = await db
          .prepare(`PRAGMA table_info(${table})`)
          .all<{ name: string }>();
        const existing = new Set(results.map((col) => col.name));
        for (const [name, type] of ADDED_COLUMNS) {
          if (!existing.has(name)) {
            await db
              .prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
              .run();
          }
        }
      });
    return ready;
  };

  return {
    async store(mention) {
      await ensureSchema();
      await db
        .prepare(
          `INSERT INTO ${table} (source, target, verified_at, rsvp, id, ` +
            `interaction_type, author_name, author_url, author_photo, ` +
            `content, published_at, vouch_url, vouch_verified) ` +
            `VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) ` +
            `ON CONFLICT (source, target) ` +
            `DO UPDATE SET verified_at = excluded.verified_at, ` +
            `rsvp = excluded.rsvp, ` +
            `id = excluded.id, ` +
            `interaction_type = excluded.interaction_type, ` +
            `author_name = excluded.author_name, ` +
            `author_url = excluded.author_url, ` +
            `author_photo = excluded.author_photo, ` +
            `content = excluded.content, ` +
            `published_at = excluded.published_at, ` +
            `vouch_url = excluded.vouch_url, ` +
            `vouch_verified = excluded.vouch_verified`,
        )
        .bind(
          mention.source,
          mention.target,
          mention.verifiedAt,
          mention.rsvp ?? null,
          mentionId(mention.source, mention.target),
          mention.interactionType ?? "mention",
          mention.author?.name ?? null,
          mention.author?.url ?? null,
          mention.author?.photo ?? null,
          mention.content ?? null,
          mention.publishedAt ?? mention.verifiedAt,
          mention.vouch?.url ?? null,
          mention.vouch !== undefined ? (mention.vouch.verified ? 1 : 0) : null,
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
      const columns =
        `id, source, target, verified_at, rsvp, interaction_type, ` +
        `author_name, author_url, author_photo, content, published_at, ` +
        `vouch_url, vouch_verified`;
      const statement =
        target === undefined
          ? db.prepare(
              `SELECT ${columns} FROM ${table} ORDER BY verified_at DESC`,
            )
          : db
              .prepare(
                `SELECT ${columns} FROM ${table} ` +
                  `WHERE target = ?1 ORDER BY verified_at DESC`,
              )
              .bind(target);
      const { results } = await statement.all<MentionRow>();
      return results.map((row) => {
        const author: MentionAuthor | undefined =
          row.author_name !== null ||
          row.author_url !== null ||
          row.author_photo !== null
            ? {
                ...(row.author_name !== null ? { name: row.author_name } : {}),
                ...(row.author_url !== null ? { url: row.author_url } : {}),
                ...(row.author_photo !== null
                  ? { photo: row.author_photo }
                  : {}),
              }
            : undefined;
        const vouch =
          row.vouch_url !== null && row.vouch_verified !== null
            ? { url: row.vouch_url, verified: row.vouch_verified !== 0 }
            : undefined;
        return {
          // Rows written before the `id` column existed re-derive it: the id
          // is a pure function of the primary key.
          id: row.id ?? mentionId(row.source, row.target),
          source: row.source,
          target: row.target,
          verifiedAt: row.verified_at,
          interactionType:
            row.interaction_type !== null &&
            isInteractionType(row.interaction_type)
              ? row.interaction_type
              : "mention",
          ...(author !== undefined ? { author } : {}),
          ...(row.content !== null ? { content: row.content } : {}),
          publishedAt: row.published_at ?? row.verified_at,
          ...(row.rsvp !== null && isRsvpValue(row.rsvp)
            ? { rsvp: row.rsvp }
            : {}),
          ...(vouch !== undefined ? { vouch } : {}),
        };
      });
    },
  };
}
