/**
 * Class 2 WebDAV locking (RFC 4918 §6) over Durable Object SQLite — spec §2.
 *
 * Lock state is net-new **authoritative** state (a lost or stale lock is a
 * correctness bug), so it lives in DO SQLite, never KV, and — because WebDAV
 * locks the *same* resources Solid writes — in the **same per-pod DO** as the
 * Solid write path. This module is the storage + conflict-detection core; the
 * router ({@link createWebdav}) maps its structured results onto HTTP status.
 *
 * Scope (spec §2):
 * - **Exclusive and shared write locks** (litmus `locks` — `lock_shared`,
 *   `double_sharedlock` — requires shared): any number of shared locks
 *   coexist on a resource; an exclusive lock conflicts with everything.
 * - `Depth: 0` resource locks (the Finder/Explorer case) and **bounded**
 *   `Depth: infinity` collection locks: forbidden on the storage root and above
 *   a configurable depth, rejected as `forbidden` (the router answers `403`).
 * - Tokens are unguessable `opaquelocktoken:<uuid>` URIs.
 * - **Expired locks are pruned opportunistically** on every operation
 *   (`DELETE … WHERE expires_at < now`), mirroring `solid-pod`'s `jti` table, so
 *   an abandoned lock never wedges a resource and the table cannot grow
 *   unbounded.
 */

import type { ResolvedLockPolicy } from "./config.js";

/** A lock's scope (RFC 4918 §6.2/§6.3). */
export type LockScope = "exclusive" | "shared";

/** A live write lock. */
export interface LockRecord {
  /** The full `opaquelocktoken:<uuid>` URI. */
  readonly token: string;
  /** The locked resource path (percent-encoded; collections end in `/`). */
  readonly path: string;
  readonly depth: "0" | "infinity";
  readonly scope: LockScope;
  /** The opaque `<owner>` XML the client supplied, or `""`. */
  readonly ownerHref: string;
  /** The WebID that holds the lock. */
  readonly webid: string;
  /** Expiry, epoch ms. */
  readonly expiresAt: number;
}

/** Parameters for {@link LockStore.acquire}. */
export interface AcquireParams {
  readonly path: string;
  readonly depth: "0" | "infinity";
  readonly scope: LockScope;
  readonly ownerHref: string;
  readonly webid: string;
  /** Requested lifetime in seconds; clamped to the policy ceiling. */
  readonly timeoutSeconds: number;
}

/** The result of attempting to acquire a lock. */
export type AcquireResult =
  | { readonly ok: true; readonly lock: LockRecord }
  | {
      readonly ok: false;
      readonly reason: "conflict";
      readonly lock: LockRecord;
    }
  | { readonly ok: false; readonly reason: "forbidden" };

type LockRow = {
  readonly token: string;
  readonly path: string;
  readonly depth: string;
  readonly scope: string;
  readonly owner_href: string;
  readonly webid: string;
  readonly expires_at: number;
};

function rowToRecord(row: LockRow): LockRecord {
  return {
    token: row.token,
    path: row.path,
    depth: row.depth === "infinity" ? "infinity" : "0",
    scope: row.scope === "shared" ? "shared" : "exclusive",
    ownerHref: row.owner_href,
    webid: row.webid,
    expiresAt: row.expires_at,
  };
}

/** A path's subtree prefix — the path itself when it ends in `/`, else `path/`. */
function subtreePrefix(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

/**
 * Whether `lock` governs `path`: an exact match, or an ancestor `Depth:
 * infinity` lock whose subtree contains `path`. The subtree test is anchored on
 * a trailing-slash prefix so a sibling that merely shares a name prefix is not
 * captured (`/dir` does not cover `/dirty`; `/dir/` covers `/dir/x`).
 */
function covers(lock: LockRecord, path: string): boolean {
  if (lock.path === path) return true;
  return lock.depth === "infinity" && path.startsWith(subtreePrefix(lock.path));
}

/** Path-segment depth, e.g. `/a/b.txt` → 2, `/a/b/` → 2, `/` → 0. */
function pathDepth(path: string): number {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? 0 : trimmed.split("/").length;
}

/** Class 2 exclusive-write lock store, backed by DO SQLite. */
export class LockStore {
  readonly #sql: SqlStorage;
  readonly #policy: ResolvedLockPolicy;
  readonly #storageRoot: string;
  readonly #now: () => number;

  /**
   * @param sql The Durable Object's `state.storage.sql`.
   * @param policy Resolved lock policy (timeouts, infinity-depth bound).
   * @param storageRoot The pod's root container path (infinity-lockable never).
   * @param now Clock injection for tests; defaults to `Date.now`.
   */
  constructor(
    sql: SqlStorage,
    policy: ResolvedLockPolicy,
    storageRoot = "/",
    now: () => number = Date.now,
  ) {
    this.#sql = sql;
    this.#policy = policy;
    this.#storageRoot = storageRoot;
    this.#now = now;
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS webdav_locks (
         token      TEXT PRIMARY KEY,
         path       TEXT NOT NULL,
         depth      TEXT NOT NULL,
         scope      TEXT NOT NULL DEFAULT 'exclusive',
         owner_href TEXT NOT NULL DEFAULT '',
         webid      TEXT NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    );
    // Migration for pre-shared-lock deployments whose table predates the
    // `scope` column; the ALTER errors harmlessly once the column exists.
    try {
      this.#sql.exec(
        `ALTER TABLE webdav_locks ADD COLUMN scope TEXT NOT NULL DEFAULT 'exclusive'`,
      );
    } catch {
      // Column already present.
    }
    this.#sql.exec(
      `CREATE INDEX IF NOT EXISTS webdav_locks_by_path ON webdav_locks (path)`,
    );
  }

  /** Drop expired rows so an abandoned lock never wedges a resource. */
  #prune(): void {
    this.#sql.exec(
      "DELETE FROM webdav_locks WHERE expires_at < ?",
      this.#now(),
    );
  }

  #liveLocks(): LockRecord[] {
    return this.#sql
      .exec<LockRow>("SELECT * FROM webdav_locks")
      .toArray()
      .map(rowToRecord);
  }

  /** Every live lock that governs `path` (shared locks allow several). */
  locksOn(path: string): LockRecord[] {
    this.#prune();
    return this.#liveLocks().filter((lock) => covers(lock, path));
  }

  /** A live lock by its token, or `null`. */
  findByToken(token: string): LockRecord | null {
    this.#prune();
    const row = this.#sql
      .exec<LockRow>("SELECT * FROM webdav_locks WHERE token = ?", token)
      .toArray()[0];
    return row ? rowToRecord(row) : null;
  }

  /**
   * Whether a mutation of `path` is blocked: a lock governs `path` (itself or an
   * ancestor infinity lock) — **or** a lock sits on a descendant of `path` —
   * and no submitted token satisfies it. Locks are grouped by locked path:
   * shared locks on one resource are satisfied by *any one* of their tokens
   * (RFC 4918 §6.3), while distinct locked paths each need a matching token —
   * the descendant check is RFC 4918 §9.6.1: a `DELETE`/overwriting `MOVE` of
   * a collection must fail if any member is locked without that member's
   * token submitted.
   */
  blockingLock(
    path: string,
    submittedTokens: readonly string[],
  ): LockRecord | null {
    const submitted = new Set(submittedTokens);
    const byPath = new Map<string, LockRecord[]>();
    const add = (lock: LockRecord) => {
      const group = byPath.get(lock.path);
      if (group) group.push(lock);
      else byPath.set(lock.path, [lock]);
    };
    const prefix = subtreePrefix(path);
    for (const lock of this.locksOn(path)) add(lock);
    for (const lock of this.#liveLocks()) {
      if (lock.path.startsWith(prefix)) add(lock);
    }
    for (const group of byPath.values()) {
      if (!group.some((lock) => submitted.has(lock.token))) {
        return group[0] ?? null;
      }
    }
    return null;
  }

  /** Attempt to take a write lock. */
  acquire(params: AcquireParams): AcquireResult {
    this.#prune();

    if (params.depth === "infinity") {
      // An unrestricted infinity lock could freeze the whole pod, so it is
      // forbidden on the root and above the configured depth bound (spec §2).
      if (params.path === this.#storageRoot)
        return { ok: false, reason: "forbidden" };
      if (pathDepth(params.path) > this.#policy.maxInfinityDepth) {
        return { ok: false, reason: "forbidden" };
      }
    }

    // Two shared locks coexist (RFC 4918 §6.3, litmus `double_sharedlock`);
    // any pairing that involves an exclusive lock conflicts.
    const conflicts = (lock: LockRecord): boolean =>
      lock.scope === "exclusive" || params.scope === "exclusive";

    const live = this.#liveLocks();
    for (const lock of live) {
      // A lock already on this exact resource, or an ancestor infinity lock
      // covering it, conflicts.
      if (
        (lock.path === params.path || covers(lock, params.path)) &&
        conflicts(lock)
      ) {
        return { ok: false, reason: "conflict", lock };
      }
      // Taking an infinity lock fails if any existing lock sits inside the
      // subtree we are trying to lock (anchored on the trailing-slash prefix so
      // a name-prefix sibling does not falsely conflict).
      if (
        params.depth === "infinity" &&
        lock.path.startsWith(subtreePrefix(params.path)) &&
        conflicts(lock)
      ) {
        return { ok: false, reason: "conflict", lock };
      }
    }

    const timeout = Math.min(
      params.timeoutSeconds,
      this.#policy.maxTimeoutSeconds,
    );
    const lock: LockRecord = {
      token: `opaquelocktoken:${crypto.randomUUID()}`,
      path: params.path,
      depth: params.depth,
      scope: params.scope,
      ownerHref: params.ownerHref,
      webid: params.webid,
      expiresAt: this.#now() + timeout * 1000,
    };
    this.#sql.exec(
      `INSERT INTO webdav_locks (token, path, depth, scope, owner_href, webid, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      lock.token,
      lock.path,
      lock.depth,
      lock.scope,
      lock.ownerHref,
      lock.webid,
      lock.expiresAt,
    );
    return { ok: true, lock };
  }

  /**
   * Refresh a lock's timeout (`LOCK` with no body). Returns the refreshed record
   * or `null` when the token names no live lock.
   */
  refresh(token: string, timeoutSeconds: number): LockRecord | null {
    const existing = this.findByToken(token);
    if (existing === null) return null;
    const timeout = Math.min(timeoutSeconds, this.#policy.maxTimeoutSeconds);
    const expiresAt = this.#now() + timeout * 1000;
    this.#sql.exec(
      "UPDATE webdav_locks SET expires_at = ? WHERE token = ?",
      expiresAt,
      token,
    );
    return { ...existing, expiresAt };
  }

  /** Release a lock. Returns whether a live lock was removed. */
  unlock(token: string): boolean {
    const existed = this.findByToken(token) !== null;
    this.#sql.exec("DELETE FROM webdav_locks WHERE token = ?", token);
    return existed;
  }
}

/**
 * Clamp a parsed `Timeout` header value to the policy default/ceiling.
 *
 * @param requested Seconds requested (`Second-N`), or `null`/`Infinite`.
 */
export function effectiveTimeout(
  requested: number | null,
  policy: ResolvedLockPolicy,
): number {
  if (requested === null) return policy.defaultTimeoutSeconds;
  return Math.min(requested, policy.maxTimeoutSeconds);
}

/**
 * Parse a WebDAV `Timeout` header (`Second-3600`, `Infinite`, comma list). The
 * first `Second-N` wins; `Infinite` and absence both map to `null` (→ default).
 */
export function parseTimeoutHeader(
  header: string | null | undefined,
): number | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /^\s*Second-(\d+)\s*$/i.exec(part);
    if (match && match[1] !== undefined) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
