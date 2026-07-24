/**
 * D1-backed authorization-code store. Codes are single-use: redemption is a
 * conditional `UPDATE … WHERE used = 0 … RETURNING`, so a replayed code cannot
 * mint a second token even under concurrency (D1 is strongly consistent — never
 * KV, per `spec/non-functional-requirements.md`). The plaintext code is never
 * stored; only its SHA-256 hash, so a store dump cannot be replayed.
 *
 * @packageDocumentation
 */

import type { D1Database } from "@cloudflare/workers-types";

import { sha256Hex } from "./encoding.js";

/** The immutable facts bound to an authorization code at issuance. */
export interface AuthorizationCodeRecord {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly webid: string;
  readonly codeChallenge: string;
  readonly nonce: string | null;
  readonly expiresAt: number;
}

/** Persistence surface for authorization codes. */
export interface CodeStore {
  /** Store a freshly-issued code (keyed by its hash). */
  save(code: string, record: AuthorizationCodeRecord): Promise<void>;
  /**
   * Atomically redeem a code: returns its record and marks it used in one
   * step, or `null` when the code is unknown, already used, or expired.
   */
  redeem(code: string, now: number): Promise<AuthorizationCodeRecord | null>;
}

interface CodeRow {
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly scope: string;
  readonly webid: string;
  readonly code_challenge: string;
  readonly nonce: string | null;
  readonly expires_at: number;
}

/** Build a D1-backed {@link CodeStore}. The table is created on first use. */
export function createCodeStore(db: D1Database): CodeStore {
  let ready: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    ready ??= db
      .prepare(
        `CREATE TABLE IF NOT EXISTS solid_oidc_codes (
           code_hash TEXT PRIMARY KEY,
           client_id TEXT NOT NULL,
           redirect_uri TEXT NOT NULL,
           scope TEXT NOT NULL,
           webid TEXT NOT NULL,
           code_challenge TEXT NOT NULL,
           nonce TEXT,
           expires_at INTEGER NOT NULL,
           used INTEGER NOT NULL DEFAULT 0)`,
      )
      .run()
      .then(() => {});
    return ready;
  };

  return {
    async save(code, record) {
      await ensureSchema();
      await db
        .prepare(
          `INSERT INTO solid_oidc_codes
             (code_hash, client_id, redirect_uri, scope, webid,
              code_challenge, nonce, expires_at, used)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)`,
        )
        .bind(
          await sha256Hex(code),
          record.clientId,
          record.redirectUri,
          record.scope,
          record.webid,
          record.codeChallenge,
          record.nonce,
          record.expiresAt,
        )
        .run();
      // Opportunistically drop expired rows so the table stays small.
      await db
        .prepare(`DELETE FROM solid_oidc_codes WHERE expires_at < ?1`)
        .bind(record.expiresAt - 1)
        .run();
    },

    async redeem(code, now) {
      await ensureSchema();
      // Single-use: flip `used` only if it was 0, returning the row atomically.
      // A concurrent second redemption sees `used = 1` and matches no row.
      const row = await db
        .prepare(
          `UPDATE solid_oidc_codes SET used = 1
             WHERE code_hash = ?1 AND used = 0 AND expires_at >= ?2
             RETURNING client_id, redirect_uri, scope, webid,
                       code_challenge, nonce, expires_at`,
        )
        .bind(await sha256Hex(code), now)
        .first<CodeRow>();
      if (!row) return null;
      return {
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        scope: row.scope,
        webid: row.webid,
        codeChallenge: row.code_challenge,
        nonce: row.nonce,
        expiresAt: row.expires_at,
      };
    },
  };
}
