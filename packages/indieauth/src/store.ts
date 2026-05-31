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

import type { CodeChallengeMethod } from "./pkce";

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
  readonly expires_at: number;
}

function rowToRecord(row: AuthCodeRow): AuthorizationCodeRecord {
  return {
    code: row.code,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    me: row.me,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method as CodeChallengeMethod,
    profile: row.profile,
    expiresAt: row.expires_at,
  };
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

  return {
    async init() {
      for (const ddl of SCHEMA) await db.prepare(ddl).run();
    },

    async saveAuthorizationCode(record) {
      await db
        .prepare(
          `INSERT INTO authorization_codes
             (code, client_id, redirect_uri, scope, me,
              code_challenge, code_challenge_method, profile, expires_at, used)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
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
          record.expiresAt,
        )
        .run();
    },

    async redeemAuthorizationCode(code, now) {
      // Flip used 0→1 and read the row back in one statement so a code can only
      // ever be redeemed once, even under concurrent token requests.
      const row = await db
        .prepare(
          `UPDATE authorization_codes
             SET used = 1
           WHERE code = ? AND used = 0 AND expires_at > ?
           RETURNING code, client_id, redirect_uri, scope, me,
                     code_challenge, code_challenge_method, profile, expires_at`,
        )
        .bind(code, now)
        .first<AuthCodeRow>();
      return row ? rowToRecord(row) : null;
    },

    async recordToken(record) {
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
      await db
        .prepare("UPDATE access_tokens SET revoked = 1 WHERE jti = ?")
        .bind(jti)
        .run();
    },
  };
}
