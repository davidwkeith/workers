/**
 * KV-indexed alarm schedule — host-contract §3.3 rule 2, issue #398.
 *
 * Alarms are indexed directly in KV (not inside the per-id SQLite file, as
 * `@dwk/cf-shims` does) so a poll can find due entries with one range scan
 * instead of opening every object's database.
 *
 * @see spec/packages/deno-host.md "Design: single-writer actor + alarm
 * emulation (issue #398)"
 */

import type { DenoKvLike, KvKey } from "./kv-client.js";

const DUE_PREFIX = "dwk_alarm_due";
const BY_ID_PREFIX = "dwk_alarm_by_id";

interface AlarmRecord {
  readonly epochMs: number;
  readonly retryCount: number;
}

function dueKey(className: string, epochMs: number, idHex: string): KvKey {
  return [DUE_PREFIX, className, epochMs, idHex];
}

function byIdKey(className: string, idHex: string): KvKey {
  return [BY_ID_PREFIX, className, idHex];
}

async function writeAlarm(
  kv: DenoKvLike,
  className: string,
  idHex: string,
  record: AlarmRecord,
  caller: string,
): Promise<void> {
  const existing = await kv.get<AlarmRecord>(byIdKey(className, idHex));
  const atomic = kv.atomic();
  if (existing.versionstamp !== null) {
    atomic.delete(dueKey(className, existing.value.epochMs, idHex));
  }
  atomic
    .set(dueKey(className, record.epochMs, idHex), record)
    .set(byIdKey(className, idHex), record);
  const result = await atomic.commit();
  if (!result.ok) {
    throw new Error(`${caller}: failed to write alarm for ${idHex}`);
  }
}

/**
 * Schedule (or replace) the single alarm for `idHex`. Always a fresh
 * schedule — `retryCount` resets to 0, matching the contract's single-slot
 * "a later call replaces" rule.
 */
export async function setAlarm(
  kv: DenoKvLike,
  className: string,
  idHex: string,
  epochMs: number,
): Promise<void> {
  await writeAlarm(
    kv,
    className,
    idHex,
    { epochMs, retryCount: 0 },
    "setAlarm",
  );
}

/**
 * Reschedule after a throwing `alarm()` handler, preserving `retryCount` so
 * the next invocation receives the right `retryCount`/`isRetry`. Not part
 * of the public `@dwk/deno-host` surface — used internally by
 * `durable-object.ts`'s `#fireAlarm` (Task 5).
 */
export async function scheduleRetry(
  kv: DenoKvLike,
  className: string,
  idHex: string,
  epochMs: number,
  retryCount: number,
): Promise<void> {
  await writeAlarm(
    kv,
    className,
    idHex,
    { epochMs, retryCount },
    "scheduleRetry",
  );
}

/** The currently scheduled time for `idHex`, or null if none is set. */
export async function getAlarm(
  kv: DenoKvLike,
  className: string,
  idHex: string,
): Promise<number | null> {
  const entry = await kv.get<AlarmRecord>(byIdKey(className, idHex));
  return entry.versionstamp === null ? null : entry.value.epochMs;
}

/** Clear the alarm for `idHex`, if any. */
export async function deleteAlarm(
  kv: DenoKvLike,
  className: string,
  idHex: string,
): Promise<void> {
  const existing = await kv.get<AlarmRecord>(byIdKey(className, idHex));
  if (existing.versionstamp === null) return;
  await kv
    .atomic()
    .delete(dueKey(className, existing.value.epochMs, idHex))
    .delete(byIdKey(className, idHex))
    .commit();
}

export interface DueAlarmEntry {
  readonly key: KvKey;
  readonly versionstamp: string;
  readonly idHex: string;
  readonly epochMs: number;
  readonly retryCount: number;
}

/** Range-scan due entries for `className` at or before `now`, oldest first. */
export async function listDueAlarms(
  kv: DenoKvLike,
  className: string,
  now: number,
  limit: number,
): Promise<DueAlarmEntry[]> {
  const out: DueAlarmEntry[] = [];
  const iter = kv.list<AlarmRecord>(
    {
      prefix: [DUE_PREFIX, className],
      end: [DUE_PREFIX, className, now + 1],
    },
    { limit },
  );
  for await (const entry of iter) {
    out.push({
      key: entry.key,
      versionstamp: entry.versionstamp as string,
      idHex: entry.key[3] as string,
      epochMs: entry.key[2] as number,
      retryCount: entry.value.retryCount,
    });
  }
  return out;
}

/**
 * Atomically claim a due entry (found via {@link listDueAlarms}) so only
 * one concurrent poller fires it. Returns false if another poller already
 * claimed it first.
 */
export async function claimDueAlarm(
  kv: DenoKvLike,
  entry: { readonly key: KvKey; readonly versionstamp: string },
): Promise<boolean> {
  const result = await kv
    .atomic()
    .check({ key: entry.key, versionstamp: entry.versionstamp })
    .delete(entry.key)
    .commit();
  return result.ok;
}

/**
 * Atomically clear the by-id record for `idHex`, but only if it currently
 * still equals `{expectedEpochMs, expectedRetryCount}` — the record a
 * `#fireAlarm` invocation claimed via {@link listDueAlarms}/
 * {@link claimDueAlarm}. Returns `false` without changing anything if the
 * by-id record has since been overwritten (e.g. a concurrent
 * `ctx.storage.setAlarm()` call legitimately rescheduled it while this
 * invocation was waiting to acquire its lease): the caller must not fire
 * the handler or touch KV further in that case — the alarm has been
 * superseded, and the new schedule is untouched.
 */
export async function clearClaimedAlarm(
  kv: DenoKvLike,
  className: string,
  idHex: string,
  expectedEpochMs: number,
  expectedRetryCount: number,
): Promise<boolean> {
  const existing = await kv.get<AlarmRecord>(byIdKey(className, idHex));
  if (
    existing.versionstamp === null ||
    existing.value.epochMs !== expectedEpochMs ||
    existing.value.retryCount !== expectedRetryCount
  ) {
    return false;
  }
  const result = await kv
    .atomic()
    .check({
      key: byIdKey(className, idHex),
      versionstamp: existing.versionstamp,
    })
    .delete(dueKey(className, expectedEpochMs, idHex))
    .delete(byIdKey(className, idHex))
    .commit();
  return result.ok;
}
