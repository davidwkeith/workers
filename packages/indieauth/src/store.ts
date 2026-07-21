/**
 * D1-backed authoritative state for the IndieAuth endpoints: short-lived,
 * single-use authorization codes and a record of issued access tokens (for
 * revocation/introspection).
 *
 * Authorization state is correctness- and security-sensitive — a code must be
 * redeemable exactly once — so it lives in D1, a strongly-consistent store, and
 * **never** KV (see `spec/non-functional-requirements.md`). Single-use
 * redemption is enforced with a conditional `UPDATE ... WHERE used = 0
 * RETURNING`, so two concurrent redemptions cannot both win.
 */

import type { CodeChallengeMethod } from "./pkce.js";

/** Cloudflare bindings required by the IndieAuth token/code store. */
export interface IndieAuthStoreEnv {
  /** D1 database holding authorization codes and issued-token records. */
  readonly AUTH_DB: D1Database;
}

/** A stored authorization code awaiting redemption. */
export interface AuthorizationCodeRecord {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly me: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: CodeChallengeMethod;
  /** JSON-encoded profile information returned at redemption, or `null`. */
  readonly profile: string | null;
  /**
   * RFC 8707 resource indicators the grant is bound to, if any. The token minted
   * at redemption is audience-restricted (`aud`) to these. Absent/empty means an
   * unrestricted token.
   */
  readonly resources?: readonly string[];
  /** Expiry (seconds since the epoch). */
  readonly expiresAt: number;
}

/** A record of an issued access token, keyed by its `jti`. */
export interface IssuedTokenRecord {
  readonly jti: string;
  readonly clientId: string;
  readonly me: string;
  readonly scope: string;
  readonly jkt: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** Storage interface over the IndieAuth authorization codes and issued tokens. */
export interface IndieAuthStore {
  /** Create the schema if absent. Idempotent. */
  init(): Promise<void>;

  /** Persist a freshly issued authorization code. */
  saveAuthorizationCode(record: AuthorizationCodeRecord): Promise<void>;

  /**
   * Atomically redeem a code: mark it used and return it, but only if it was
   * still unused and unexpired at `now`. Returns `null` otherwise (unknown,
   * already redeemed, or expired), so redemption is single-use even under
   * concurrent requests.
   */
  redeemAuthorizationCode(
    code: string,
    now: number,
  ): Promise<AuthorizationCodeRecord | null>;

  /** Record an issued access token so it can later be revoked/introspected. */
  recordToken(record: IssuedTokenRecord): Promise<void>;

  /** Whether a token is currently valid (recorded, unexpired, not revoked). */
  isTokenActive(jti: string, now: number): Promise<boolean>;

  /** Revoke a token by `jti`. No-op if it is unknown. */
  revokeToken(jti: string): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS authorization_codes (
     code TEXT PRIMARY KEY,
     client_id TEXT NOT NULL,
     redirect_uri TEXT NOT NULL,
     scope TEXT NOT NULL,
     me TEXT NOT NULL,
     code_challenge TEXT NOT NULL,
     code_challenge_method TEXT NOT NULL,
     profile TEXT,
     resource TEXT,
     expires_at INTEGER NOT NULL,
     used INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS access_tokens (
     jti TEXT PRIMARY KEY,
     client_id TEXT NOT NULL,
     me TEXT NOT NULL,
     scope TEXT NOT NULL,
     jkt TEXT NOT NULL,
     issued_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     revoked INTEGER NOT NULL DEFAULT 0
   )`,
] as const;

interface AuthCodeRow {
  readonly code: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly scope: string;
  readonly me: string;
  readonly code_challenge: string;
  readonly code_challenge_method: string;
  readonly profile: string | null;
  readonly resource: string | null;
  readonly expires_at: number;
}

function rowToRecord(row: AuthCodeRow): AuthorizationCodeRecord {
  const resources = parseResources(row.resource);
  return {
    code: row.code,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    me: row.me,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method as CodeChallengeMethod,
    profile: row.profile,
    ...(resources ? { resources } : {}),
    expiresAt: row.expires_at,
  };
}

/**
 * Add `column` to `table` when it is not already present, for backward-compatible
 * schema evolution on durable D1 databases. The table/column/type are internal
 * constants (never user input), so interpolating them into the DDL is safe; a
 * `PRAGMA table_info` check keeps this idempotent rather than relying on
 * swallowing a duplicate-column error.
 */
async function addColumnIfMissing(
  db: D1Database,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  const info = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>();
  if (info.results.some((row) => row.name === column)) return;
  await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
}

/**
 * Delete expired rows from both tables. Called opportunistically from the two
 * insert paths (a fresh authorization code or a newly issued token) rather
 * than on a schedule — this package has no cron entrypoint of its own — so
 * `authorization_codes` and `access_tokens` don't grow unbounded and slow
 * `isTokenActive`'s scan as a deployment accumulates history. A `used`
 * authorization code or a `revoked` token is only actually reclaimed once it
 * also expires, matching `redeemAuthorizationCode`/`isTokenActive`'s own
 * expiry check — nothing here changes what those two already treat as
 * expired.
 */
async function pruneExpired(db: D1Database, nowSeconds: number): Promise<void> {
  await db.batch([
    db
      .prepare("DELETE FROM authorization_codes WHERE expires_at <= ?")
      .bind(nowSeconds),
    db
      .prepare("DELETE FROM access_tokens WHERE expires_at <= ?")
      .bind(nowSeconds),
  ]);
}

/** Parse the JSON-encoded `resource` column into a non-empty list, or `undefined`. */
function parseResources(raw: string | null): readonly string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((value) => typeof value === "string")
    ) {
      return parsed as string[];
    }
  } catch {
    // Fall through to undefined on a malformed column value.
  }
  return undefined;
}

/**
 * Create the D1-backed {@link IndieAuthStore}. Fails loudly if the required
 * `AUTH_DB` binding is missing — no silent degradation (composition contract).
 */
export function createIndieAuthStore(env: IndieAuthStoreEnv): IndieAuthStore {
  if (!env.AUTH_DB) {
    throw new Error("@dwk/indieauth: missing required D1 binding `AUTH_DB`");
  }
  const db = env.AUTH_DB;

  // Create the schema lazily on first use so a consumer that composes the
  // package against a fresh D1 never needs a separate migration step: the first
  // request to reach the store materialises the tables (and runs the RFC 8707
  // column migration). Mirrors the lazy-schema pattern the
  // webmention/websub/microsub stores use. The cached promise is cleared on
  // failure so a transient D1 error during the first call doesn't permanently
  // wedge the store.
  let ready: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    ready ??= (async () => {
      for (const ddl of SCHEMA) await db.prepare(ddl).run();
      // Migration: a database created before the RFC 8707 `resource` column
      // existed still has the old `authorization_codes` shape, and
      // `CREATE TABLE IF NOT EXISTS` above will not add the column. Patch it in
      // when absent so saving/redeeming a code never hits `no such column`.
      // Idempotent — a no-op once the column is present.
      await addColumnIfMissing(db, "authorization_codes", "resource", "TEXT");
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

    async saveAuthorizationCode(record) {
      await ensureSchema();
      await pruneExpired(db, Math.floor(Date.now() / 1000));
      await db
        .prepare(
          `INSERT INTO authorization_codes
             (code, client_id, redirect_uri, scope, me,
              code_challenge, code_challenge_method, profile, resource,
              expires_at, used)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(
          record.code,
          record.clientId,
          record.redirectUri,
          record.scope,
          record.me,
          record.codeChallenge,
          record.codeChallengeMethod,
          record.profile,
          record.resources && record.resources.length > 0
            ? JSON.stringify(record.resources)
            : null,
          record.expiresAt,
        )
        .run();
    },

    async redeemAuthorizationCode(code, now) {
      await ensureSchema();
      // Flip used 0→1 and read the row back in one statement so a code can only
      // ever be redeemed once, even under concurrent token requests.
      const row = await db
        .prepare(
          `UPDATE authorization_codes
             SET used = 1
           WHERE code = ? AND used = 0 AND expires_at > ?
           RETURNING code, client_id, redirect_uri, scope, me,
                     code_challenge, code_challenge_method, profile, resource,
                     expires_at`,
        )
        .bind(code, now)
        .first<AuthCodeRow>();
      return row ? rowToRecord(row) : null;
    },

    async recordToken(record) {
      await ensureSchema();
      await pruneExpired(db, Math.floor(Date.now() / 1000));
      await db
        .prepare(
          `INSERT INTO access_tokens
             (jti, client_id, me, scope, jkt, issued_at, expires_at, revoked)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(
          record.jti,
          record.clientId,
          record.me,
          record.scope,
          record.jkt,
          record.issuedAt,
          record.expiresAt,
        )
        .run();
    },

    async isTokenActive(jti, now) {
      await ensureSchema();
      const row = await db
        .prepare(
          `SELECT 1 AS ok FROM access_tokens
           WHERE jti = ? AND revoked = 0 AND expires_at > ?`,
        )
        .bind(jti, now)
        .first<{ ok: number }>();
      return row !== null;
    },

    async revokeToken(jti) {
      await ensureSchema();
      await db
        .prepare("UPDATE access_tokens SET revoked = 1 WHERE jti = ?")
        .bind(jti)
        .run();
    },
  };
}
