/**
 * D1-backed authoritative state: registered apps (as `@dwk/oauth`
 * `ClientRecord`s — `clientSecret` holds the SHA-256 hash), single-use
 * authorization codes (conditional `UPDATE … RETURNING`), SHA-256-hashed
 * opaque bearer tokens, and per-timeline read markers. Auth state is
 * security-sensitive, so it lives in D1 — **never KV**
 * (spec/non-functional-requirements.md).
 */

import type { ClientRecord, ClientStore } from "@dwk/oauth";

import type { MastodonApiEnv } from "./config.js";

/** A stored authorization code awaiting redemption. */
export interface MastodonCodeRecord {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /** Space-separated scopes the grant covers (echoed as granted). */
  readonly scope: string;
  /** PKCE S256 challenge when the client sent one, else `null`. */
  readonly codeChallenge: string | null;
  /** Expiry (seconds since the epoch). */
  readonly expiresAt: number;
}

/** An issued opaque access token, stored only as its SHA-256 hash. */
export interface MastodonTokenRecord {
  readonly tokenHash: string;
  readonly clientId: string;
  readonly scope: string;
  /** `OWNER_ACCOUNT_ID` for user tokens; `null` for `client_credentials`. */
  readonly accountId: string | null;
  /** Issued-at (seconds since the epoch) — Mastodon's `created_at`. */
  readonly createdAt: number;
  readonly revoked: boolean;
}

/** A saved read position for one timeline (`/api/v1/markers`). */
export interface MastodonMarkerRecord {
  readonly timeline: "home" | "notifications";
  readonly lastReadId: string;
  readonly version: number;
  /** Last update (seconds since the epoch). */
  readonly updatedAt: number;
}

/**
 * Storage over apps, codes, tokens, and markers. The app half implements
 * `@dwk/oauth`'s {@link ClientStore} seam directly.
 */
export interface MastodonStore extends ClientStore {
  /** Create the schema if absent. Idempotent. */
  init(): Promise<void>;
  /** Persist a freshly issued authorization code. */
  saveCode(record: MastodonCodeRecord): Promise<void>;
  /**
   * Atomically redeem a code: mark it used and return it, but only if it was
   * still unused and unexpired at `now`. Returns `null` otherwise, so
   * redemption is single-use even under concurrent token requests.
   */
  redeemCode(code: string, now: number): Promise<MastodonCodeRecord | null>;
  /** Record an issued token (hash only — never the token itself). */
  saveToken(record: MastodonTokenRecord): Promise<void>;
  /** Look up a token by its SHA-256 hash, or `null` when unknown. */
  getToken(tokenHash: string): Promise<MastodonTokenRecord | null>;
  /** Revoke a token by hash. No-op if it is unknown (RFC 7009 semantics). */
  revokeToken(tokenHash: string): Promise<void>;
  /** Saved markers for the requested timelines (missing ones omitted). */
  getMarkers(
    timelines: readonly string[],
  ): Promise<readonly MastodonMarkerRecord[]>;
  /** Upsert a marker, bumping its version; returns the stored row. */
  saveMarker(
    timeline: "home" | "notifications",
    lastReadId: string,
    now: number,
  ): Promise<MastodonMarkerRecord>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mastodon_apps (
     client_id TEXT PRIMARY KEY,
     client_secret_hash TEXT NOT NULL,
     metadata TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS mastodon_codes (
     code TEXT PRIMARY KEY,
     client_id TEXT NOT NULL,
     redirect_uri TEXT NOT NULL,
     scope TEXT NOT NULL,
     code_challenge TEXT,
     expires_at INTEGER NOT NULL,
     used INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS mastodon_tokens (
     token_hash TEXT PRIMARY KEY,
     client_id TEXT NOT NULL,
     scope TEXT NOT NULL,
     account_id TEXT,
     created_at INTEGER NOT NULL,
     revoked INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS mastodon_markers (
     timeline TEXT PRIMARY KEY,
     last_read_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_mastodon_codes_expires_at
     ON mastodon_codes(expires_at)`,
] as const;

/** An unauthorized registration is reclaimed after 30 days (Decision 2). */
const STALE_APP_SECONDS = 30 * 24 * 60 * 60;

interface CodeRow {
  readonly code: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly scope: string;
  readonly code_challenge: string | null;
  readonly expires_at: number;
}

interface TokenRow {
  readonly token_hash: string;
  readonly client_id: string;
  readonly scope: string;
  readonly account_id: string | null;
  readonly created_at: number;
  readonly revoked: number;
}

interface MarkerRow {
  readonly timeline: string;
  readonly last_read_id: string;
  readonly version: number;
  readonly updated_at: number;
}

function markerFromRow(row: MarkerRow): MastodonMarkerRecord {
  return {
    timeline: row.timeline as "home" | "notifications",
    lastReadId: row.last_read_id,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

/**
 * Create the D1-backed {@link MastodonStore}. Fails loudly if the required
 * `AUTH_DB` binding is missing — no silent degradation (composition contract).
 */
export function createMastodonStore(env: MastodonApiEnv): MastodonStore {
  if (!env.AUTH_DB) {
    throw new Error("@dwk/mastodon-api: missing required D1 binding `AUTH_DB`");
  }
  const db = env.AUTH_DB;

  // Lazy schema creation on first use, so composing against a fresh D1 needs
  // no separate migration step (the indieauth/webmention store pattern). The
  // cached promise is cleared on failure so a transient D1 error during the
  // first call doesn't permanently wedge the store.
  let ready: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    ready ??= (async () => {
      for (const ddl of SCHEMA) await db.prepare(ddl).run();
    })().catch((err: unknown) => {
      ready = null;
      throw err;
    });
    return ready;
  };

  return {
    async init() {
      await ensureSchema();
    },

    async saveClient(record) {
      await ensureSchema();
      const now = Math.floor(Date.now() / 1000);
      // Opportunistic housekeeping on the one unauthenticated write path:
      // expired codes, and registrations that never earned a token within 30
      // days — Mastodon app registration is open, so this bounds its cost to
      // one D1 row per unwanted registration for at most a month.
      await db.batch([
        db
          .prepare("DELETE FROM mastodon_codes WHERE expires_at <= ?")
          .bind(now),
        db
          .prepare(
            `DELETE FROM mastodon_apps
              WHERE created_at <= ?
                AND client_id NOT IN (SELECT client_id FROM mastodon_tokens)`,
          )
          .bind(now - STALE_APP_SECONDS),
      ]);
      await db
        .prepare(
          `INSERT OR REPLACE INTO mastodon_apps
             (client_id, client_secret_hash, metadata, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(
          record.clientId,
          record.clientSecret ?? "",
          JSON.stringify(record.metadata),
          record.clientIdIssuedAt,
        )
        .run();
    },

    async getClient(clientId) {
      await ensureSchema();
      const row = await db
        .prepare(
          `SELECT client_id, client_secret_hash, metadata, created_at
             FROM mastodon_apps WHERE client_id = ?`,
        )
        .bind(clientId)
        .first<{
          client_id: string;
          client_secret_hash: string;
          metadata: string;
          created_at: number;
        }>();
      if (!row) return null;
      const record: ClientRecord = {
        clientId: row.client_id,
        clientIdIssuedAt: row.created_at,
        ...(row.client_secret_hash
          ? { clientSecret: row.client_secret_hash }
          : {}),
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      };
      return record;
    },

    async saveCode(record) {
      await ensureSchema();
      await db
        .prepare(
          `INSERT INTO mastodon_codes
             (code, client_id, redirect_uri, scope, code_challenge,
              expires_at, used)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(
          record.code,
          record.clientId,
          record.redirectUri,
          record.scope,
          record.codeChallenge,
          record.expiresAt,
        )
        .run();
    },

    async redeemCode(code, now) {
      await ensureSchema();
      // Flip used 0→1 and read the row back in one statement so a code can
      // only ever be redeemed once, even under concurrent token requests.
      const row = await db
        .prepare(
          `UPDATE mastodon_codes SET used = 1
            WHERE code = ? AND used = 0 AND expires_at > ?
            RETURNING code, client_id, redirect_uri, scope, code_challenge,
                      expires_at`,
        )
        .bind(code, now)
        .first<CodeRow>();
      if (!row) return null;
      return {
        code: row.code,
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        scope: row.scope,
        codeChallenge: row.code_challenge,
        expiresAt: row.expires_at,
      };
    },

    async saveToken(record) {
      await ensureSchema();
      await db
        .prepare(
          `INSERT INTO mastodon_tokens
             (token_hash, client_id, scope, account_id, created_at, revoked)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          record.tokenHash,
          record.clientId,
          record.scope,
          record.accountId,
          record.createdAt,
          record.revoked ? 1 : 0,
        )
        .run();
    },

    async getToken(tokenHash) {
      await ensureSchema();
      const row = await db
        .prepare(
          `SELECT token_hash, client_id, scope, account_id, created_at, revoked
             FROM mastodon_tokens WHERE token_hash = ?`,
        )
        .bind(tokenHash)
        .first<TokenRow>();
      if (!row) return null;
      return {
        tokenHash: row.token_hash,
        clientId: row.client_id,
        scope: row.scope,
        accountId: row.account_id,
        createdAt: row.created_at,
        revoked: row.revoked !== 0,
      };
    },

    async revokeToken(tokenHash) {
      await ensureSchema();
      await db
        .prepare("UPDATE mastodon_tokens SET revoked = 1 WHERE token_hash = ?")
        .bind(tokenHash)
        .run();
    },

    async getMarkers(timelines) {
      await ensureSchema();
      if (timelines.length === 0) return [];
      const placeholders = timelines.map(() => "?").join(", ");
      const result = await db
        .prepare(
          `SELECT timeline, last_read_id, version, updated_at
             FROM mastodon_markers WHERE timeline IN (${placeholders})`,
        )
        .bind(...timelines)
        .all<MarkerRow>();
      return result.results.map(markerFromRow);
    },

    async saveMarker(timeline, lastReadId, now) {
      await ensureSchema();
      const row = await db
        .prepare(
          `INSERT INTO mastodon_markers (timeline, last_read_id, version, updated_at)
             VALUES (?, ?, 1, ?)
           ON CONFLICT(timeline) DO UPDATE SET
             last_read_id = excluded.last_read_id,
             version = mastodon_markers.version + 1,
             updated_at = excluded.updated_at
           RETURNING timeline, last_read_id, version, updated_at`,
        )
        .bind(timeline, lastReadId, now)
        .first<MarkerRow>();
      if (!row) {
        throw new Error("@dwk/mastodon-api: marker upsert returned no row");
      }
      return markerFromRow(row);
    },
  };
}
