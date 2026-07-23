/**
 * Media metadata store, URL ownership validation, and `q=source` query
 * parsing for the proposed Micropub media-endpoint extensions (issue #363
 * design): media listing, upload response body, and recoverable
 * `action=delete`/`undelete`.
 *
 * R2 keys are random UUIDs, so R2 listing alone cannot produce the
 * newest-first ordering `q=source` needs; every stored blob gets a row in the
 * strongly-consistent `micropub_media` D1 table (never KV). R2 remains the
 * blob authority — the row is ordering/metadata bookkeeping.
 *
 * @see spec/packages/micropub.md#proposed-media-endpoint-extensions
 */

import type { PageRequest } from "./pagination.js";

/** Cloudflare binding required by the media metadata store. */
export interface MediaStoreEnv {
  /** D1 database holding media metadata rows (shared with the post store). */
  readonly MICROPUB_DB: D1Database;
}

/**
 * Upload content types mapped to the R2 key extension the generator appends.
 * Doubles as the allowlist of types safe to serve inline (see the handler's
 * blob `GET` route): anything else is served as an opaque
 * `application/octet-stream` attachment.
 */
export const MEDIA_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
};

/** R2 key prefix holding recoverable (soft-deleted) media blobs. */
export const MEDIA_TRASH_PREFIX = ".trash/";

/** The trash-namespace R2 key for a live media key. */
export function mediaTrashKey(key: string): string {
  return `${MEDIA_TRASH_PREFIX}${key}`;
}

/**
 * The generator format for media keys: a lowercase UUID plus an optional
 * known extension (the values of {@link MEDIA_EXTENSIONS}). Anchored so a
 * key is always exactly one path segment.
 */
const KEY_PATTERN = new RegExp(
  `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:${Object.values(
    MEDIA_EXTENSIONS,
  )
    .map((ext) => ext.replace(".", "\\."))
    .join("|")})?$`,
);

/**
 * Resolve a client-supplied `url` to the media key it names, or `null` if it
 * is not owned by this media endpoint. This is the load-bearing ownership
 * validation for the delete/undelete actions and the by-URL query: the URL
 * must be absolute and canonicalize to exactly `${mediaEndpoint}/<key>` with
 * `<key>` a single generator-format path segment — no other origins or path
 * prefixes, no traversal or encoded-slash key confusion, no query or
 * fragment, and never the trash prefix.
 */
export function mediaKeyFromUrl(
  url: string,
  mediaEndpoint: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.search !== "" || parsed.hash !== "") return null;
  const endpoint = new URL(mediaEndpoint);
  if (parsed.protocol !== endpoint.protocol) return null;
  if (parsed.origin !== endpoint.origin) return null;
  const prefix = `${endpoint.pathname}/`;
  if (!parsed.pathname.startsWith(prefix)) return null;
  const key = parsed.pathname.slice(prefix.length);
  // Percent-encoded bytes could smuggle a slash (or dot segments) past the
  // single-segment check once decoded downstream; the generator never
  // percent-encodes, so any `%` is foreign.
  if (key.includes("%")) return null;
  if (!KEY_PATTERN.test(key)) return null;
  return key;
}

/** Raised when a media query or action carries an invalid parameter. */
export class MediaValidationError extends Error {}

/** A validated media `q=source` request: by URL, or a listing page. */
export type MediaSourceQuery = { url: string } | { page: PageRequest };

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function requireAtMostOne(
  params: URLSearchParams,
  name: string,
): string | null {
  const values = params.getAll(name);
  if (values.length > 1) {
    throw new MediaValidationError(`\`${name}\` must not be repeated`);
  }
  return values[0] ?? null;
}

function parseNonNegativeInteger(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new MediaValidationError(
      `\`${name}\` must be a non-negative integer, got "${raw}"`,
    );
  }
  return Number(raw);
}

/**
 * Parse and validate a media-endpoint `q=source` query string: either a
 * single `url`, or an optional `limit` (default 10, max 100) and `offset`
 * (default 0) page. Every duplicated, unknown, or malformed parameter is
 * rejected rather than ignored, matching the other proposed extension
 * queries.
 */
export function parseMediaSourceParams(
  params: URLSearchParams,
): MediaSourceQuery {
  const allowed = new Set(["q", "url", "limit", "offset"]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) {
      throw new MediaValidationError(
        `unsupported media \`q=source\` query parameter \`${key}\``,
      );
    }
  }

  const url = requireAtMostOne(params, "url");
  const limitRaw = requireAtMostOne(params, "limit");
  const offsetRaw = requireAtMostOne(params, "offset");

  if (url !== null) {
    if (limitRaw !== null || offsetRaw !== null) {
      throw new MediaValidationError(
        "`limit`/`offset` do not apply to a single-file `url` query",
      );
    }
    return { url };
  }

  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    limit = parseNonNegativeInteger(limitRaw, "limit");
    if (limit < 1) {
      throw new MediaValidationError("`limit` must be at least 1");
    }
    limit = Math.min(limit, MAX_LIMIT);
  }
  const offset =
    offsetRaw === null ? 0 : parseNonNegativeInteger(offsetRaw, "offset");
  return { page: { limit, offset } };
}

// --- D1 media metadata store --------------------------------------------------

/** A stored media blob's metadata row. */
export interface MediaRecord {
  /** R2 key (primary key); the public URL is `${mediaEndpoint}/${key}`. */
  readonly key: string;
  /** Stored content type, as declared at upload. */
  readonly contentType: string;
  /** Blob size in bytes. */
  readonly sizeBytes: number;
  /** Upload time (seconds since the epoch). */
  readonly uploadedAt: number;
  /** Soft-delete time (seconds since the epoch), or `null` while live. */
  readonly deletedAt: number | null;
}

/** Storage interface over media metadata rows. */
export interface MicropubMediaStore {
  /** Create the schema if absent. Idempotent. */
  init(): Promise<void>;
  /** Insert a new upload's row. */
  record(record: {
    key: string;
    contentType: string;
    sizeBytes: number;
    now: number;
  }): Promise<void>;
  /** Read a row (including soft-deleted ones), or `null` if unknown. */
  get(key: string): Promise<MediaRecord | null>;
  /**
   * List live (non-deleted) media newest-first by upload time with `key` as
   * the deterministic tie-breaker. The caller owns limit/offset validation.
   */
  list(page: PageRequest): Promise<readonly MediaRecord[]>;
  /**
   * Set or clear a row's soft-delete time. Returns `false` if the key is
   * unknown (a legacy blob with no row).
   */
  setDeleted(key: string, deletedAt: number | null): Promise<boolean>;
  /**
   * Hard-delete a row, for rolling an upload back before its URL was ever
   * handed out (multi-file fold failure). Idempotent.
   */
  remove(key: string): Promise<void>;
  /**
   * Remove rows soft-deleted before `cutoff` (seconds since the epoch). The
   * blob bytes under the trash prefix are purged by an R2 lifecycle rule, so
   * this is opportunistic row hygiene, not correctness.
   */
  pruneExpired(cutoff: number): Promise<void>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS micropub_media (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL,
  deleted_at INTEGER
)`;

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS micropub_media_live ON micropub_media (deleted_at, uploaded_at, key)",
];

interface MediaRow {
  readonly key: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly uploaded_at: number;
  readonly deleted_at: number | null;
}

function rowToRecord(row: MediaRow): MediaRecord {
  return {
    key: row.key,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    uploadedAt: row.uploaded_at,
    deletedAt: row.deleted_at,
  };
}

/** Create the built-in D1 media metadata store. */
export function createMicropubMediaStore(
  env: MediaStoreEnv,
): MicropubMediaStore {
  const db = env.MICROPUB_DB;
  let ready: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    ready ??= db
      .prepare(SCHEMA)
      .run()
      .then(async () => {
        await db.batch(INDEXES.map((sql) => db.prepare(sql)));
      })
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
    async record({ key, contentType, sizeBytes, now }) {
      await ensureSchema();
      await db
        .prepare(
          `INSERT INTO micropub_media (key, content_type, size_bytes, uploaded_at, deleted_at)
           VALUES (?, ?, ?, ?, NULL)`,
        )
        .bind(key, contentType, sizeBytes, now)
        .run();
    },
    async get(key) {
      await ensureSchema();
      const row = await db
        .prepare(
          `SELECT key, content_type, size_bytes, uploaded_at, deleted_at
             FROM micropub_media WHERE key = ?`,
        )
        .bind(key)
        .first<MediaRow>();
      return row ? rowToRecord(row) : null;
    },
    async list(page) {
      await ensureSchema();
      const { results } = await db
        .prepare(
          `SELECT key, content_type, size_bytes, uploaded_at, deleted_at
             FROM micropub_media
            WHERE deleted_at IS NULL
            ORDER BY uploaded_at DESC, key DESC
            LIMIT ? OFFSET ?`,
        )
        .bind(page.limit, page.offset)
        .all<MediaRow>();
      return (results ?? []).map(rowToRecord);
    },
    async setDeleted(key, deletedAt) {
      await ensureSchema();
      const result = await db
        .prepare("UPDATE micropub_media SET deleted_at = ? WHERE key = ?")
        .bind(deletedAt, key)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },
    async remove(key) {
      await ensureSchema();
      await db
        .prepare("DELETE FROM micropub_media WHERE key = ?")
        .bind(key)
        .run();
    },
    async pruneExpired(cutoff) {
      await ensureSchema();
      await db
        .prepare(
          "DELETE FROM micropub_media WHERE deleted_at IS NOT NULL AND deleted_at < ?",
        )
        .bind(cutoff)
        .run();
    },
  };
}
