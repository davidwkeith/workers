/**
 * App-password persistence + throttled verification over DO SQLite — spec §1.
 *
 * The pure mint/verify crypto lives in {@link ./credentials.js}; this module is
 * the **authoritative at-rest store** (hash-only, never the plaintext) plus the
 * per-credential **failed-attempt throttling** the spec mandates against
 * brute force. Like the lock table it is net-new authoritative state and lives
 * in DO SQLite, never KV. Verification is constant-time (delegated to
 * {@link verifyAppPassword}); expired rows are pruned opportunistically.
 */

import {
  mintAppPassword,
  verifyAppPassword,
  type AppPasswordRecord,
  type AppPasswordScope,
  type MintAppPasswordParams,
  type MintedAppPassword,
} from "./credentials.js";

/** Resolved throttling policy. */
export interface ThrottlePolicy {
  /** Failed attempts before a credential is temporarily refused. */
  readonly maxFailedAttempts: number;
  /** How long (ms) a run of failures suppresses further attempts / decays. */
  readonly windowMs: number;
}

/** Outcome of {@link CredentialStore.verify}. */
export type VerifyResult =
  | { readonly ok: true; readonly record: AppPasswordRecord }
  | { readonly ok: false; readonly reason: "mismatch" | "throttled" };

type CredentialRow = {
  readonly credential_id: string;
  readonly webid: string;
  readonly label: string;
  readonly scope_modes: string;
  readonly scope_prefix: string;
  readonly salt_hex: string;
  readonly hash_hex: string;
  readonly iterations: number;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly failed_count: number;
  readonly failed_since: number;
};

function parseModes(value: string): AppPasswordScope["modes"] {
  const modes = value
    .split(",")
    .map((m) => m.trim())
    .filter((m): m is "read" | "write" => m === "read" || m === "write");
  return modes;
}

function rowToRecord(row: CredentialRow): AppPasswordRecord {
  const scope: AppPasswordScope =
    row.scope_prefix === ""
      ? { modes: parseModes(row.scope_modes) }
      : { modes: parseModes(row.scope_modes), pathPrefix: row.scope_prefix };
  return {
    credentialId: row.credential_id,
    webid: row.webid,
    label: row.label,
    scope,
    saltHex: row.salt_hex,
    hashHex: row.hash_hex,
    iterations: row.iterations,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

const DEFAULT_THROTTLE: ThrottlePolicy = {
  maxFailedAttempts: 10,
  windowMs: 15 * 60 * 1000,
};

/** Per-pod app-password store, backed by DO SQLite. */
export class CredentialStore {
  readonly #sql: SqlStorage;
  readonly #throttle: ThrottlePolicy;
  readonly #now: () => number;

  constructor(
    sql: SqlStorage,
    throttle: Partial<ThrottlePolicy> = {},
    now: () => number = Date.now,
  ) {
    this.#sql = sql;
    this.#throttle = { ...DEFAULT_THROTTLE, ...throttle };
    this.#now = now;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS webdav_credentials (
         credential_id TEXT PRIMARY KEY,
         webid         TEXT NOT NULL,
         label         TEXT NOT NULL,
         scope_modes   TEXT NOT NULL,
         scope_prefix  TEXT NOT NULL DEFAULT '',
         salt_hex      TEXT NOT NULL,
         hash_hex      TEXT NOT NULL,
         iterations    INTEGER NOT NULL,
         created_at    INTEGER NOT NULL,
         expires_at    INTEGER,
         failed_count  INTEGER NOT NULL DEFAULT 0,
         failed_since  INTEGER NOT NULL DEFAULT 0
       )`,
    );
    this.#sql.exec(
      `CREATE INDEX IF NOT EXISTS webdav_credentials_by_webid
         ON webdav_credentials (webid)`,
    );
  }

  /** Drop expired credentials so the table cannot grow unbounded. */
  #prune(): void {
    this.#sql.exec(
      "DELETE FROM webdav_credentials WHERE expires_at IS NOT NULL AND expires_at < ?",
      this.#now(),
    );
  }

  #row(credentialId: string): CredentialRow | undefined {
    return this.#sql
      .exec<CredentialRow>(
        "SELECT * FROM webdav_credentials WHERE credential_id = ?",
        credentialId,
      )
      .toArray()[0];
  }

  /** Mint a new app password (owner-gated at the HTTP layer) and persist it. */
  async mint(params: MintAppPasswordParams): Promise<MintedAppPassword> {
    const minted = await mintAppPassword({ now: this.#now, ...params });
    const { record } = minted;
    this.#sql.exec(
      `INSERT INTO webdav_credentials
         (credential_id, webid, label, scope_modes, scope_prefix,
          salt_hex, hash_hex, iterations, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.credentialId,
      record.webid,
      record.label,
      record.scope.modes.join(","),
      record.scope.pathPrefix ?? "",
      record.saltHex,
      record.hashHex,
      record.iterations,
      record.createdAt,
      record.expiresAt,
    );
    return minted;
  }

  /** Fetch a stored credential by id (live only), or `null`. */
  get(credentialId: string): AppPasswordRecord | null {
    this.#prune();
    const row = this.#row(credentialId);
    return row ? rowToRecord(row) : null;
  }

  /** List a WebID's credentials (metadata; the secret was never stored). */
  list(webid: string): AppPasswordRecord[] {
    this.#prune();
    return this.#sql
      .exec<CredentialRow>(
        "SELECT * FROM webdav_credentials WHERE webid = ? ORDER BY created_at",
        webid,
      )
      .toArray()
      .map(rowToRecord);
  }

  /** Revoke a credential. Returns whether a row was removed. */
  revoke(credentialId: string): boolean {
    const existed = this.#row(credentialId) !== undefined;
    this.#sql.exec(
      "DELETE FROM webdav_credentials WHERE credential_id = ?",
      credentialId,
    );
    return existed;
  }

  /**
   * Verify a presented Basic `(credentialId, secret)` with per-credential
   * throttling. A run of `maxFailedAttempts` within `windowMs` suppresses
   * further attempts until the window elapses; a success resets the counter.
   */
  async verify(credentialId: string, secret: string): Promise<VerifyResult> {
    this.#prune();
    const row = this.#row(credentialId);
    if (row === undefined) return { ok: false, reason: "mismatch" };

    const now = this.#now();
    // Decay a stale failure run before evaluating the throttle. Track the
    // post-decay counters locally so a subsequent failure anchors `failed_since`
    // on `now` rather than the stale (decayed) timestamp.
    let failedCount = row.failed_count;
    let failedSince = row.failed_since;
    if (failedCount > 0 && now - failedSince >= this.#throttle.windowMs) {
      this.#sql.exec(
        "UPDATE webdav_credentials SET failed_count = 0, failed_since = 0 WHERE credential_id = ?",
        credentialId,
      );
      failedCount = 0;
      failedSince = 0;
    } else if (failedCount >= this.#throttle.maxFailedAttempts) {
      return { ok: false, reason: "throttled" };
    }

    const record = rowToRecord(row);
    const valid = await verifyAppPassword(secret, record, this.#now);
    if (valid) {
      this.#sql.exec(
        "UPDATE webdav_credentials SET failed_count = 0, failed_since = 0 WHERE credential_id = ?",
        credentialId,
      );
      return { ok: true, record };
    }

    const nextFailedSince = failedCount === 0 ? now : failedSince;
    this.#sql.exec(
      "UPDATE webdav_credentials SET failed_count = failed_count + 1, failed_since = ? WHERE credential_id = ?",
      nextFailedSince,
      credentialId,
    );
    return { ok: false, reason: "mismatch" };
  }
}
