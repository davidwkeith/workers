/**
 * `@dwk/microsub` — D1-backed authoritative state.
 *
 * Channels, the feeds each channel follows, the normalised JF2 timeline items,
 * their per-item read flags, and a small per-feed poll cache (`ETag` /
 * `Last-Modified`) all live here. This is correctness-sensitive state — a lost
 * subscription or a dropped read flag is a bug, not a stale cache — so it lives
 * in D1, a strongly-consistent store, and **never** KV (see
 * `spec/non-functional-requirements.md`). The schema is created lazily on first
 * use.
 *
 * Timeline paging uses a monotonic `seq` (an autoincrement rowid): the opaque
 * `before` / `after` cursors a Microsub client round-trips are just `seq`
 * values, so paging is stable under concurrent inserts and deletes.
 *
 * @packageDocumentation
 */

import type { D1Database } from "@cloudflare/workers-types";

import type { Jf2Entry } from "./jf2";

/** The reserved channel that always exists and cannot be deleted or renamed. */
export const NOTIFICATIONS_CHANNEL = "notifications";

/** Cloudflare binding required by the Microsub store. */
export interface MicrosubStoreEnv {
  /** D1 database holding channels, follows, items, and the poll cache. */
  readonly MICROSUB_DB: D1Database;
}

/** A channel: its stable uid, display name, and sort position. */
export interface ChannelRecord {
  readonly uid: string;
  readonly name: string;
  readonly position: number;
  readonly createdAt: number;
}

/** A subscription within a channel. */
export interface FollowRecord {
  /** The resolved feed URL polled by the server. */
  readonly feedUrl: string;
  /** The page URL the user originally followed (feed discovered from it). */
  readonly pageUrl: string;
  readonly createdAt: number;
}

/** A stored timeline item: the JF2 entry plus its bookkeeping. */
export interface StoredItem {
  readonly seq: number;
  readonly channel: string;
  readonly entryId: string;
  readonly feedUrl: string;
  readonly isRead: boolean;
  readonly entry: Jf2Entry;
}

/** A page of timeline items with the opaque cursors to fetch adjacent pages. */
export interface ItemPage {
  readonly items: readonly StoredItem[];
  readonly before?: string;
  readonly after?: string;
}

/** A cached conditional-request validator for a feed. */
export interface FeedCache {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

/** Options for {@link MicrosubStore.listItems}. */
export interface ListOptions {
  readonly before?: string;
  readonly after?: string;
  readonly limit: number;
}

/** Storage interface over the Microsub state. */
export interface MicrosubStore {
  /** Create the schema if absent. Idempotent. */
  init(): Promise<void>;

  // Channels --------------------------------------------------------------
  /** List channels in sort order, the reserved `notifications` channel first. */
  listChannels(): Promise<ChannelRecord[]>;
  /** Whether a channel with this uid exists. */
  channelExists(uid: string): Promise<boolean>;
  /** Create a channel with a freshly generated uid. */
  createChannel(name: string, now: number): Promise<ChannelRecord>;
  /** Rename a channel; returns the updated record, or `null` if unknown. */
  renameChannel(uid: string, name: string): Promise<ChannelRecord | null>;
  /**
   * Delete a channel and everything it owns (follows + items). Returns `false`
   * if the uid is unknown or names the reserved channel.
   */
  deleteChannel(uid: string): Promise<boolean>;
  /** Apply a new sort order; uids absent from `order` keep their relative order after. */
  reorderChannels(order: readonly string[]): Promise<void>;

  // Follows ---------------------------------------------------------------
  /** List a channel's subscriptions. */
  listFollows(channel: string): Promise<FollowRecord[]>;
  /** Add (or refresh) a subscription. */
  addFollow(
    channel: string,
    feedUrl: string,
    pageUrl: string,
    now: number,
  ): Promise<void>;
  /**
   * Remove a subscription, matching `url` against either the resolved feed URL
   * or the page URL the user originally followed (a client unfollows with the
   * URL it was given back, which is the page URL). Returns `false` if it was not
   * present.
   */
  removeFollow(channel: string, url: string): Promise<boolean>;
  /** Every distinct feed URL across all channels (for the poller). */
  distinctFeedUrls(): Promise<string[]>;
  /** Channels that follow a given feed URL (for the consumer). */
  channelsForFeed(feedUrl: string): Promise<string[]>;

  // Items -----------------------------------------------------------------
  /**
   * Append entries to a channel, deduped by entry id. Returns the count newly
   * inserted. Entries should be passed newest-last so the newest gets the
   * highest `seq`. Reaps beyond `maxItems` oldest items afterwards.
   */
  insertItems(
    channel: string,
    feedUrl: string,
    entries: readonly Jf2Entry[],
    now: number,
    maxItems: number,
  ): Promise<number>;
  /** A page of a channel's timeline. */
  listItems(channel: string, options: ListOptions): Promise<ItemPage>;
  /** Count of unread items in a channel. */
  unreadCount(channel: string): Promise<number>;
  /** Mark specific items read/unread. */
  markRead(
    channel: string,
    entryIds: readonly string[],
    read: boolean,
  ): Promise<void>;
  /** Mark every item up to and including `entryId` (by `seq`) as read. */
  markReadThrough(channel: string, entryId: string): Promise<void>;
  /** Remove an item from a channel. Returns `false` if it was not present. */
  removeItem(channel: string, entryId: string): Promise<boolean>;
  /** Substring search over a channel's items (name + content). */
  searchItems(
    channel: string,
    query: string,
    limit: number,
  ): Promise<StoredItem[]>;

  // Feed poll cache -------------------------------------------------------
  /** The cached validators for a feed, or `null`. */
  getFeedCache(feedUrl: string): Promise<FeedCache | null>;
  /** Record the validators returned by a feed fetch. */
  setFeedCache(
    feedUrl: string,
    etag: string | null,
    lastModified: string | null,
    now: number,
  ): Promise<void>;
}

const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS microsub_channels (
     uid TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     position INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS microsub_follows (
     channel TEXT NOT NULL,
     feed_url TEXT NOT NULL,
     page_url TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (channel, feed_url)
   )`,
  `CREATE TABLE IF NOT EXISTS microsub_items (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     channel TEXT NOT NULL,
     entry_id TEXT NOT NULL,
     feed_url TEXT NOT NULL,
     published INTEGER,
     is_read INTEGER NOT NULL DEFAULT 0,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (channel, entry_id)
   )`,
  `CREATE INDEX IF NOT EXISTS microsub_items_channel_seq
     ON microsub_items (channel, seq)`,
  `CREATE TABLE IF NOT EXISTS microsub_feeds (
     feed_url TEXT PRIMARY KEY,
     etag TEXT,
     last_modified TEXT,
     last_polled INTEGER
   )`,
];

interface ChannelRow {
  readonly uid: string;
  readonly name: string;
  readonly position: number;
  readonly created_at: number;
}

interface FollowRow {
  readonly feed_url: string;
  readonly page_url: string;
  readonly created_at: number;
}

interface ItemRow {
  readonly seq: number;
  readonly channel: string;
  readonly entry_id: string;
  readonly feed_url: string;
  readonly is_read: number;
  readonly data: string;
}

function channelFromRow(row: ChannelRow): ChannelRecord {
  return {
    uid: row.uid,
    name: row.name,
    position: row.position,
    createdAt: row.created_at,
  };
}

function itemFromRow(row: ItemRow): StoredItem {
  const entry = JSON.parse(row.data) as Jf2Entry;
  return {
    seq: row.seq,
    channel: row.channel,
    entryId: row.entry_id,
    feedUrl: row.feed_url,
    isRead: row.is_read !== 0,
    entry: { ...entry, _is_read: row.is_read !== 0 },
  };
}

/** Parse a `published` ISO string to an epoch-seconds sort key, or `null`. */
function publishedToEpoch(entry: Jf2Entry): number | null {
  if (!entry.published) return null;
  const ms = Date.parse(entry.published);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** A short, URL-safe channel uid: base36 timestamp plus random suffix. */
function generateUid(): string {
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 36 ** 5)
    .toString(36)
    .padStart(5, "0");
  return `${time}${rand}`;
}

/**
 * Create the D1-backed {@link MicrosubStore}. Fails loudly if the required
 * `MICROSUB_DB` binding is missing — no silent degradation (composition
 * contract).
 */
export function createMicrosubStore(env: MicrosubStoreEnv): MicrosubStore {
  if (!env.MICROSUB_DB) {
    throw new Error("@dwk/microsub: missing required D1 binding `MICROSUB_DB`");
  }
  const db = env.MICROSUB_DB;

  // The init promise is cached per store instance (not module-globally): the
  // vitest-pool-workers test model resets D1 between tests while keeping one
  // `env` singleton, so a global cache would skip re-creating the wiped tables.
  // This matches `@dwk/websub`'s store. The reserved `notifications` channel is
  // materialised as part of the same batch, so it always exists after any store
  // operation — a client may hit `timeline`/`unread` for it on a fresh DB
  // without first listing channels.
  let ready: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    // Clear the cached promise on failure so a transient D1 error during the
    // first call doesn't permanently wedge the store.
    ready ??= db
      .batch([
        ...SCHEMA.map((ddl) => db.prepare(ddl)),
        db
          .prepare(
            `INSERT OR IGNORE INTO microsub_channels (uid, name, position, created_at)
             VALUES (?1, ?2, -1, ?3)`,
          )
          .bind(
            NOTIFICATIONS_CHANNEL,
            "Notifications",
            Math.floor(Date.now() / 1000),
          ),
      ])
      .then(() => undefined)
      .catch((err: unknown) => {
        ready = null;
        throw err;
      });
    return ready;
  };

  const seqOf = async (
    channel: string,
    entryId: string,
  ): Promise<number | null> => {
    const row = await db
      .prepare(
        `SELECT seq FROM microsub_items WHERE channel = ?1 AND entry_id = ?2`,
      )
      .bind(channel, entryId)
      .first<{ seq: number }>();
    return row?.seq ?? null;
  };

  return {
    async init() {
      await ensureSchema();
    },

    // Channels ------------------------------------------------------------
    async listChannels() {
      await ensureSchema();
      const { results } = await db
        .prepare(
          `SELECT uid, name, position, created_at FROM microsub_channels
           ORDER BY position ASC, created_at ASC`,
        )
        .all<ChannelRow>();
      return results.map(channelFromRow);
    },

    async channelExists(uid) {
      await ensureSchema();
      const row = await db
        .prepare(`SELECT 1 AS present FROM microsub_channels WHERE uid = ?1`)
        .bind(uid)
        .first<{ present: number }>();
      return row !== null;
    },

    async createChannel(name, now) {
      await ensureSchema();
      const max = await db
        .prepare(`SELECT MAX(position) AS maxPos FROM microsub_channels`)
        .first<{ maxPos: number | null }>();
      const position = (max?.maxPos ?? -1) + 1;
      const uid = generateUid();
      await db
        .prepare(
          `INSERT INTO microsub_channels (uid, name, position, created_at)
           VALUES (?1, ?2, ?3, ?4)`,
        )
        .bind(uid, name, position, now)
        .run();
      return { uid, name, position, createdAt: now };
    },

    async renameChannel(uid, name) {
      await ensureSchema();
      if (uid === NOTIFICATIONS_CHANNEL) return null;
      const result = await db
        .prepare(`UPDATE microsub_channels SET name = ?2 WHERE uid = ?1`)
        .bind(uid, name)
        .run();
      if (result.meta.changes === 0) return null;
      const row = await db
        .prepare(
          `SELECT uid, name, position, created_at FROM microsub_channels WHERE uid = ?1`,
        )
        .bind(uid)
        .first<ChannelRow>();
      return row ? channelFromRow(row) : null;
    },

    async deleteChannel(uid) {
      await ensureSchema();
      if (uid === NOTIFICATIONS_CHANNEL) return false;
      const result = await db.batch([
        db.prepare(`DELETE FROM microsub_channels WHERE uid = ?1`).bind(uid),
        db.prepare(`DELETE FROM microsub_follows WHERE channel = ?1`).bind(uid),
        db.prepare(`DELETE FROM microsub_items WHERE channel = ?1`).bind(uid),
      ]);
      return (result[0]?.meta.changes ?? 0) > 0;
    },

    async reorderChannels(order) {
      await ensureSchema();
      const statements = order.map((uid, index) =>
        db
          .prepare(`UPDATE microsub_channels SET position = ?2 WHERE uid = ?1`)
          .bind(uid, index),
      );
      if (statements.length > 0) await db.batch(statements);
    },

    // Follows -------------------------------------------------------------
    async listFollows(channel) {
      await ensureSchema();
      const { results } = await db
        .prepare(
          `SELECT feed_url, page_url, created_at FROM microsub_follows
           WHERE channel = ?1 ORDER BY created_at ASC`,
        )
        .bind(channel)
        .all<FollowRow>();
      return results.map((row) => ({
        feedUrl: row.feed_url,
        pageUrl: row.page_url,
        createdAt: row.created_at,
      }));
    },

    async addFollow(channel, feedUrl, pageUrl, now) {
      await ensureSchema();
      await db
        .prepare(
          `INSERT INTO microsub_follows (channel, feed_url, page_url, created_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (channel, feed_url) DO UPDATE SET page_url = excluded.page_url`,
        )
        .bind(channel, feedUrl, pageUrl, now)
        .run();
    },

    async removeFollow(channel, url) {
      await ensureSchema();
      const result = await db
        .prepare(
          `DELETE FROM microsub_follows
           WHERE channel = ?1 AND (feed_url = ?2 OR page_url = ?2)`,
        )
        .bind(channel, url)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async distinctFeedUrls() {
      await ensureSchema();
      const { results } = await db
        .prepare(`SELECT DISTINCT feed_url FROM microsub_follows`)
        .all<{ feed_url: string }>();
      return results.map((row) => row.feed_url);
    },

    async channelsForFeed(feedUrl) {
      await ensureSchema();
      const { results } = await db
        .prepare(`SELECT channel FROM microsub_follows WHERE feed_url = ?1`)
        .bind(feedUrl)
        .all<{ channel: string }>();
      return results.map((row) => row.channel);
    },

    // Items ---------------------------------------------------------------
    async insertItems(channel, feedUrl, entries, now, maxItems) {
      await ensureSchema();
      if (entries.length === 0) return 0;
      const statements = entries.map((entry) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO microsub_items
               (channel, entry_id, feed_url, published, is_read, data, created_at)
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)`,
          )
          .bind(
            channel,
            entry._id,
            feedUrl,
            publishedToEpoch(entry),
            JSON.stringify(entry),
            now,
          ),
      );
      const results = await db.batch(statements);
      const added = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);

      // Retention: reap the oldest items past the ceiling so a runaway feed
      // can't fill the store unbounded.
      if (added > 0) {
        await db
          .prepare(
            `DELETE FROM microsub_items
             WHERE channel = ?1 AND seq NOT IN (
               SELECT seq FROM microsub_items WHERE channel = ?1
               ORDER BY seq DESC LIMIT ?2
             )`,
          )
          .bind(channel, maxItems)
          .run();
      }
      return added;
    },

    async listItems(channel, options) {
      await ensureSchema();
      const limit = Math.max(1, options.limit);
      let rows: ItemRow[];
      if (options.after !== undefined) {
        const after = Number.parseInt(options.after, 10);
        const { results } = await db
          .prepare(
            `SELECT seq, channel, entry_id, feed_url, is_read, data
             FROM microsub_items WHERE channel = ?1 AND seq > ?2
             ORDER BY seq ASC LIMIT ?3`,
          )
          .bind(channel, Number.isFinite(after) ? after : 0, limit)
          .all<ItemRow>();
        rows = results.slice().reverse();
      } else {
        const before =
          options.before !== undefined
            ? Number.parseInt(options.before, 10)
            : Number.MAX_SAFE_INTEGER;
        const { results } = await db
          .prepare(
            `SELECT seq, channel, entry_id, feed_url, is_read, data
             FROM microsub_items WHERE channel = ?1 AND seq < ?2
             ORDER BY seq DESC LIMIT ?3`,
          )
          .bind(
            channel,
            Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER,
            limit,
          )
          .all<ItemRow>();
        rows = results;
      }
      const items = rows.map(itemFromRow);
      const page: { items: StoredItem[]; before?: string; after?: string } = {
        items,
      };
      if (items.length > 0) {
        const last = items[items.length - 1];
        const first = items[0];
        // `before` advances to older entries. Offer it when the page filled
        // (there may be more below), and always when paginating with `after`:
        // even a partial newer-page sits above the entries we paged up from, so
        // the client must be able to navigate back down. `after` always points
        // past the newest seen.
        if ((items.length === limit || options.after !== undefined) && last) {
          page.before = String(last.seq);
        }
        if (first) page.after = String(first.seq);
      }
      return page;
    },

    async unreadCount(channel) {
      await ensureSchema();
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM microsub_items WHERE channel = ?1 AND is_read = 0`,
        )
        .bind(channel)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    async markRead(channel, entryIds, read) {
      await ensureSchema();
      if (entryIds.length === 0) return;
      const flag = read ? 1 : 0;
      const statements = entryIds.map((id) =>
        db
          .prepare(
            `UPDATE microsub_items SET is_read = ?3 WHERE channel = ?1 AND entry_id = ?2`,
          )
          .bind(channel, id, flag),
      );
      await db.batch(statements);
    },

    async markReadThrough(channel, entryId) {
      await ensureSchema();
      const seq = await seqOf(channel, entryId);
      if (seq === null) return;
      await db
        .prepare(
          `UPDATE microsub_items SET is_read = 1 WHERE channel = ?1 AND seq <= ?2`,
        )
        .bind(channel, seq)
        .run();
    },

    async removeItem(channel, entryId) {
      await ensureSchema();
      const result = await db
        .prepare(
          `DELETE FROM microsub_items WHERE channel = ?1 AND entry_id = ?2`,
        )
        .bind(channel, entryId)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async searchItems(channel, query, limit) {
      await ensureSchema();
      const like = `%${query.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
      const { results } = await db
        .prepare(
          `SELECT seq, channel, entry_id, feed_url, is_read, data
           FROM microsub_items
           WHERE channel = ?1 AND data LIKE ?2 ESCAPE '\\'
           ORDER BY seq DESC LIMIT ?3`,
        )
        .bind(channel, like, Math.max(1, limit))
        .all<ItemRow>();
      return results.map(itemFromRow);
    },

    // Feed poll cache -----------------------------------------------------
    async getFeedCache(feedUrl) {
      await ensureSchema();
      const row = await db
        .prepare(
          `SELECT etag, last_modified FROM microsub_feeds WHERE feed_url = ?1`,
        )
        .bind(feedUrl)
        .first<{ etag: string | null; last_modified: string | null }>();
      if (row === null) return null;
      return { etag: row.etag, lastModified: row.last_modified };
    },

    async setFeedCache(feedUrl, etag, lastModified, now) {
      await ensureSchema();
      await db
        .prepare(
          `INSERT INTO microsub_feeds (feed_url, etag, last_modified, last_polled)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (feed_url) DO UPDATE SET
             etag = excluded.etag,
             last_modified = excluded.last_modified,
             last_polled = excluded.last_polled`,
        )
        .bind(feedUrl, etag, lastModified, now)
        .run();
    },
  };
}
