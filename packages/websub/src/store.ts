/**
 * `@dwk/websub` — D1-backed subscription store.
 *
 * The set of active subscriptions is authoritative state: a stale or lost row
 * means a subscriber stops receiving pushes (or keeps receiving them past lease
 * expiry), which is a correctness bug, not a safe-to-be-stale cache. It therefore
 * lives in **D1 (strongly consistent), never KV** — see
 * `spec/non-functional-requirements.md`. A subscription is keyed on the
 * `(callback, topic)` pair so re-subscribing renews the lease in place. Rows are
 * written only **after** intent verification succeeds. See
 * `spec/packages/websub.md`.
 *
 * @packageDocumentation
 */

import type { D1Database } from "@cloudflare/workers-types";

/** A verified, active subscription. */
export interface Subscription {
  readonly callback: string;
  readonly topic: string;
  /** HMAC secret to sign deliveries with, or `null` when none was registered. */
  readonly secret: string | null;
  /** Granted lease length, in seconds. */
  readonly leaseSeconds: number;
  /** Lease expiry, epoch milliseconds. After this the subscription is dead. */
  readonly expiresAt: number;
  /** Creation/last-renewal time, epoch milliseconds. */
  readonly createdAt: number;
}

/** Fields needed to upsert (create or renew) a subscription. */
export interface SubscriptionUpsert {
  readonly callback: string;
  readonly topic: string;
  readonly secret?: string | undefined;
  readonly leaseSeconds: number;
  /** Now, epoch milliseconds; `expiresAt` is derived as `now + leaseSeconds*1000`. */
  readonly now: number;
}

/** Persistence surface for subscriptions. */
export interface SubscriptionStore {
  /** Upsert (create or renew) a verified subscription, keyed on `(callback, topic)`. */
  upsert(subscription: SubscriptionUpsert): Promise<void>;
  /** Remove a subscription; no-op when absent. */
  remove(callback: string, topic: string): Promise<void>;
  /** List subscriptions for `topic` that are still within their lease at `now`. */
  listActive(topic: string, now: number): Promise<Subscription[]>;
  /** Look up one subscription, or `null` when absent. */
  get(callback: string, topic: string): Promise<Subscription | null>;
  /** Delete every subscription whose lease expired at or before `now`; returns the count removed. */
  pruneExpired(now: number): Promise<number>;
}

/** Options for {@link createD1SubscriptionStore}. */
export interface D1StoreOptions {
  /** Table name to use; created if absent. Defaults to `websub_subscriptions`. */
  readonly table?: string;
}

interface SubscriptionRow {
  readonly callback: string;
  readonly topic: string;
  readonly secret: string | null;
  readonly lease_seconds: number;
  readonly expires_at: number;
  readonly created_at: number;
}

function rowToSubscription(row: SubscriptionRow): Subscription {
  return {
    callback: row.callback,
    topic: row.topic,
    secret: row.secret,
    leaseSeconds: row.lease_seconds,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/**
 * Build a D1-backed {@link SubscriptionStore}. The backing table is created on
 * first use if it does not already exist.
 */
export function createD1SubscriptionStore(
  db: D1Database,
  options?: D1StoreOptions,
): SubscriptionStore {
  const table = options?.table ?? "websub_subscriptions";
  // Guard the identifier: it is interpolated into DDL, so only allow a safe
  // set of characters rather than trusting the caller blindly.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`@dwk/websub: invalid subscription table name "${table}".`);
  }

  let ready: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> => {
    // Clear the cached promise on failure so a transient D1 error during the
    // first call doesn't permanently wedge the store: a later operation retries
    // the DDL instead of inheriting the cached rejection.
    ready ??= db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${table} (` +
          `callback TEXT NOT NULL, ` +
          `topic TEXT NOT NULL, ` +
          `secret TEXT, ` +
          `lease_seconds INTEGER NOT NULL, ` +
          `expires_at INTEGER NOT NULL, ` +
          `created_at INTEGER NOT NULL, ` +
          `PRIMARY KEY (callback, topic))`,
      )
      .run()
      .then(() => undefined)
      .catch((err: unknown) => {
        ready = null;
        throw err;
      });
    return ready;
  };

  return {
    async upsert(subscription) {
      await ensureSchema();
      const expiresAt = subscription.now + subscription.leaseSeconds * 1000;
      await db
        .prepare(
          `INSERT INTO ${table} ` +
            `(callback, topic, secret, lease_seconds, expires_at, created_at) ` +
            `VALUES (?1, ?2, ?3, ?4, ?5, ?6) ` +
            `ON CONFLICT (callback, topic) DO UPDATE SET ` +
            `secret = excluded.secret, ` +
            `lease_seconds = excluded.lease_seconds, ` +
            `expires_at = excluded.expires_at, ` +
            `created_at = excluded.created_at`,
        )
        .bind(
          subscription.callback,
          subscription.topic,
          subscription.secret ?? null,
          subscription.leaseSeconds,
          expiresAt,
          subscription.now,
        )
        .run();
    },

    async remove(callback, topic) {
      await ensureSchema();
      await db
        .prepare(`DELETE FROM ${table} WHERE callback = ?1 AND topic = ?2`)
        .bind(callback, topic)
        .run();
    },

    async listActive(topic, now) {
      await ensureSchema();
      const { results } = await db
        .prepare(
          `SELECT callback, topic, secret, lease_seconds, expires_at, created_at ` +
            `FROM ${table} WHERE topic = ?1 AND expires_at > ?2 ` +
            `ORDER BY created_at ASC`,
        )
        .bind(topic, now)
        .all<SubscriptionRow>();
      return results.map(rowToSubscription);
    },

    async get(callback, topic) {
      await ensureSchema();
      const row = await db
        .prepare(
          `SELECT callback, topic, secret, lease_seconds, expires_at, created_at ` +
            `FROM ${table} WHERE callback = ?1 AND topic = ?2`,
        )
        .bind(callback, topic)
        .first<SubscriptionRow>();
      return row === null ? null : rowToSubscription(row);
    },

    async pruneExpired(now) {
      await ensureSchema();
      const result = await db
        .prepare(`DELETE FROM ${table} WHERE expires_at <= ?1`)
        .bind(now)
        .run();
      return result.meta.changes ?? 0;
    },
  };
}
