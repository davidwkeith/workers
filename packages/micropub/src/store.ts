/**
 * D1-backed authoritative state for published posts: each post's microformats2
 * source keyed by its canonical URL, plus a soft-delete flag so `delete` and
 * `undelete` are reversible.
 *
 * Published content is correctness-sensitive (a `q=source` read must reflect the
 * last write), so it lives in D1 — a strongly-consistent store — and **never**
 * KV (see `spec/non-functional-requirements.md`). Media blob bodies live in R2;
 * only their metadata-free URLs ever appear in post properties.
 */

import type { Mf2Object } from "./mf2.js";

/** Cloudflare binding required by the Micropub post store. */
export interface MicropubStoreEnv {
  /** D1 database holding published post records. */
  readonly MICROPUB_DB: D1Database;
}

/** A stored post: its mf2 source plus bookkeeping. */
export interface PostRecord {
  /** Canonical URL (primary key). */
  readonly url: string;
  /** Primary mf2 type, e.g. `"h-entry"`. */
  readonly type: string;
  /** mf2 property map. */
  readonly properties: Record<string, unknown[]>;
  /** Whether the post is currently soft-deleted. */
  readonly deleted: boolean;
  /** Creation time (seconds since the epoch). */
  readonly createdAt: number;
  /** Last-modification time (seconds since the epoch). */
  readonly updatedAt: number;
}

/** Storage interface over published posts. */
export interface MicropubStore {
  /** Create the schema if absent. Idempotent. */
  init(): Promise<void>;
  /**
   * Insert a new post. Returns `false` (without overwriting) if the URL is
   * already taken, so the caller can pick another.
   */
  insertPost(record: {
    url: string;
    type: string;
    properties: Record<string, unknown[]>;
    now: number;
  }): Promise<boolean>;
  /** Read a post (including soft-deleted ones), or `null` if unknown. */
  getPost(url: string): Promise<PostRecord | null>;
  /** Overwrite a live post's properties. Returns `false` if it is unknown/deleted. */
  updateProperties(
    url: string,
    properties: Record<string, unknown[]>,
    now: number,
  ): Promise<boolean>;
  /** Set a post's soft-delete flag. Returns `false` if the URL is unknown. */
  setDeleted(url: string, deleted: boolean, now: number): Promise<boolean>;
  /**
   * Distinct string `category` (tag) values across all live posts, for the
   * `q=category` autocomplete extension. `filter` narrows to values that
   * contain the substring (case-insensitive); `limit` caps the count. Ordered
   * alphabetically for a stable response. Non-string categories (e.g. nested
   * `h-card` tag objects) are excluded.
   */
  listCategories(options?: {
    filter?: string;
    limit?: number;
  }): Promise<string[]>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS posts (
   url TEXT PRIMARY KEY,
   type TEXT NOT NULL,
   properties TEXT NOT NULL,
   deleted INTEGER NOT NULL DEFAULT 0,
   created_at INTEGER NOT NULL,
   updated_at INTEGER NOT NULL
 )`;

interface PostRow {
  readonly url: string;
  readonly type: string;
  readonly properties: string;
  readonly deleted: number;
  readonly created_at: number;
  readonly updated_at: number;
}

function rowToRecord(row: PostRow): PostRecord {
  return {
    url: row.url,
    type: row.type,
    properties: JSON.parse(row.properties) as Record<string, unknown[]>,
    deleted: row.deleted !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create the D1-backed {@link MicropubStore}. Fails loudly if the required
 * `MICROPUB_DB` binding is missing — no silent degradation (composition
 * contract).
 */
export function createMicropubStore(env: MicropubStoreEnv): MicropubStore {
  if (!env.MICROPUB_DB) {
    throw new Error("@dwk/micropub: missing required D1 binding `MICROPUB_DB`");
  }
  const db = env.MICROPUB_DB;

  // Create the schema lazily on first use so a consumer that composes the
  // package against a fresh D1 never needs a separate migration step: the first
  // request to reach the store materialises the table. Mirrors the lazy-schema
  // pattern the webmention/websub/microsub stores use. The cached promise is
  // cleared on failure so a transient D1 error during the first call doesn't
  // permanently wedge the store.
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

    async insertPost({ url, type, properties, now }) {
      await ensureSchema();
      // `INSERT OR IGNORE` leaves an existing row untouched; `meta.changes`
      // tells us whether this URL was free.
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO posts
             (url, type, properties, deleted, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
        )
        .bind(url, type, JSON.stringify(properties), now, now)
        .run();
      return result.meta.changes > 0;
    },

    async getPost(url) {
      await ensureSchema();
      const row = await db
        .prepare(
          `SELECT url, type, properties, deleted, created_at, updated_at
             FROM posts WHERE url = ?`,
        )
        .bind(url)
        .first<PostRow>();
      return row ? rowToRecord(row) : null;
    },

    async updateProperties(url, properties, now) {
      await ensureSchema();
      const result = await db
        .prepare(
          `UPDATE posts SET properties = ?, updated_at = ?
             WHERE url = ? AND deleted = 0`,
        )
        .bind(JSON.stringify(properties), now, url)
        .run();
      return result.meta.changes > 0;
    },

    async setDeleted(url, deleted, now) {
      await ensureSchema();
      const result = await db
        .prepare(`UPDATE posts SET deleted = ?, updated_at = ? WHERE url = ?`)
        .bind(deleted ? 1 : 0, now, url)
        .run();
      return result.meta.changes > 0;
    },

    async listCategories(options = {}) {
      await ensureSchema();
      const { filter, limit } = options;
      // Walk each live post's `category` array with SQLite's json_each; a post
      // without the property (or a non-array value) simply contributes no rows.
      // `je.type = 'text'` keeps plain-string tags and drops nested objects.
      const clauses = ["p.deleted = 0", "je.type = 'text'"];
      const binds: unknown[] = [];
      if (filter) {
        clauses.push("instr(lower(je.value), lower(?)) > 0");
        binds.push(filter);
      }
      let sql = `SELECT DISTINCT je.value AS category
           FROM posts AS p, json_each(p.properties, '$.category') AS je
          WHERE ${clauses.join(" AND ")}
          ORDER BY category ASC`;
      if (limit !== undefined) {
        sql += " LIMIT ?";
        binds.push(limit);
      }
      const result = await db
        .prepare(sql)
        .bind(...binds)
        .all<{ category: string }>();
      return (result.results ?? []).map((row) => row.category);
    },
  };
}

/** A post's mf2 source view, reconstructed from a {@link PostRecord}. */
export function recordToMf2(record: PostRecord): Mf2Object {
  return { type: [record.type], properties: record.properties };
}
