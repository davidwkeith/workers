/**
 * Per-id lease over Deno KV atomic CAS — host-contract §3.3 rule 1 (per-id
 * single writer), issue #398. Acquired once per `fetch()`/`alarm()`
 * delivery and released after — see spec/packages/deno-host.md "Design:
 * single-writer actor + alarm emulation (issue #398)" for why per-request
 * rather than a renewed session lease, and why bounded-retry-then-fail
 * rather than unbounded waiting.
 */

import type { DenoKvLike, KvKey } from "./kv-client.js";

export class LeaseContendedError extends Error {
  constructor(key: KvKey) {
    const formatted = key
      .map((part) =>
        typeof part === "bigint" ? `${part}n` : JSON.stringify(part),
      )
      .join(", ");
    super(`lease contended: [${formatted}]`);
    this.name = "LeaseContendedError";
  }
}

export interface LeaseOptions {
  /** How long a held lease survives without release (crash safety net). */
  readonly ttlMs?: number;
  /** Total time to keep retrying an acquire before giving up. */
  readonly acquireTimeoutMs?: number;
}

export interface Lease {
  readonly key: KvKey;
  readonly versionstamp: string;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_BASE_MS = 50;
const RETRY_MAX_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the lease at `key`, retrying with capped exponential backoff
 * until `acquireTimeoutMs` elapses. Throws {@link LeaseContendedError} if
 * the timeout elapses without acquiring.
 */
export async function acquireLease(
  kv: DenoKvLike,
  key: KvKey,
  options: LeaseOptions = {},
): Promise<Lease> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const acquireTimeoutMs =
    options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const deadline = Date.now() + acquireTimeoutMs;
  let attempt = 0;
  for (;;) {
    const result = await kv
      .atomic()
      .check({ key, versionstamp: null })
      .set(key, { holder: crypto.randomUUID() }, { expireIn: ttlMs })
      .commit();
    if (result.ok && result.versionstamp !== undefined) {
      return { key, versionstamp: result.versionstamp };
    }
    if (Date.now() >= deadline) {
      throw new LeaseContendedError(key);
    }
    const backoff = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
    attempt += 1;
    await delay(backoff);
  }
}

/**
 * Release a lease previously returned by {@link acquireLease}. A no-op if
 * the lease already expired and a different holder has since acquired it
 * (verified via the versionstamp captured at acquire time).
 */
export async function releaseLease(
  kv: DenoKvLike,
  lease: Lease,
): Promise<void> {
  await kv
    .atomic()
    .check({ key: lease.key, versionstamp: lease.versionstamp })
    .delete(lease.key)
    .commit();
}
