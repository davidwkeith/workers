/**
 * `LibsqlKv` — the scale-out coordination store: `@dwk/deno-host`'s
 * `DenoKvLike` seam implemented over one dedicated logical libSQL database,
 * so the lease / alarm / queue machinery built on that seam (per-id
 * single-writer leases, the KV-indexed alarm schedule, the durable queue
 * broker) can run against the same centralized SQL service the `central`
 * storage mode already requires — no third coordination technology.
 *
 * One table holds everything: `k` is an **order-preserving tuple encoding**
 * of the key array (so `list`'s range scans over BLOB-`memcmp` primary-key
 * order match the key-array order the consumers assume — numeric parts sort
 * numerically), `ver` is a store-wide monotonic versionstamp bumped once per
 * committing atomic write (equality-CAS only, which is all the consumers
 * use; a store-wide counter, unlike a per-key one, can never repeat a stamp
 * after a sweep deletes and a later write recreates a key), and
 * `expires_at` implements `expireIn` lazily — expired rows are invisible to
 * `get`/`list`/`check` immediately and physically removed by
 * {@link LibsqlKv.sweepExpired}, which poll ticks call.
 *
 * Atomicity rides entirely on the injected client's `batch(stmts, "write")`
 * contract (one implicit transaction, in order, all-or-nothing): a commit
 * evaluates its checks into a scratch row **before** any mutation runs, and
 * every mutation is guarded by that stored verdict, so checks always see
 * pre-mutation state and a failed check applies nothing. Like every
 * `@dwk/deno-host` seam consumer, this module never constructs a
 * connection — the composing host injects a `LibsqlClientLike`.
 *
 * Two documented divergences from `Deno.Kv` (both invisible to the
 * `@dwk/deno-host` consumers, whose CAS is equality-only and whose keys mix
 * types only across positions, never within one): all `set`s in one atomic
 * commit share a single versionstamp, and string parts order by UTF-8 bytes
 * (code points), not UTF-16 units.
 *
 * @see spec/scale-out.md §8 (design; issue #428)
 */

import type {
  DenoKvAtomicLike,
  DenoKvCheckLike,
  DenoKvCommitResultLike,
  DenoKvEntryLike,
  DenoKvLike,
  DenoKvListSelectorLike,
  KvKey,
  KvKeyPart,
  LibsqlClientLike,
  LibsqlStatementLike,
  SqlValue,
} from "@dwk/deno-host";

/* ---------- order-preserving key codec ---------- */

// Element tags, in Deno.Kv's documented cross-type order:
// Uint8Array < string < number < bigint < boolean.
const TAG_BYTES = 0x01;
const TAG_STRING = 0x02;
const TAG_NUMBER = 0x03;
const TAG_BIGINT = 0x04;
const TAG_BOOLEAN = 0x05;

const BIGINT_OFFSET = 1n << 63n;
const U64_MASK = 0xffffffffffffffffn;
const SIGN_BIT = 0x8000000000000000n;

/** 0x00 → 0x00 0xFF escape + 0x00 terminator (FoundationDB-tuple style), so
 *  a longer string/byte part always memcmp-sorts after its own prefix and a
 *  key's encoding is a byte-prefix of every key it is an element-prefix of. */
function pushEscaped(out: number[], bytes: Uint8Array): void {
  for (const byte of bytes) {
    out.push(byte);
    if (byte === 0x00) out.push(0xff);
  }
  out.push(0x00);
}

function pushUint64(out: number[], bits: bigint): void {
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    out.push(Number((bits >> shift) & 0xffn));
  }
}

/** IEEE-754 sign-flip transform: total numeric order under unsigned memcmp. */
function numberToOrderedBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  return bits & SIGN_BIT ? ~bits & U64_MASK : bits | SIGN_BIT;
}

function orderedBitsToNumber(bits: bigint): number {
  const raw = bits & SIGN_BIT ? bits & ~SIGN_BIT & U64_MASK : ~bits & U64_MASK;
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, raw, false);
  return view.getFloat64(0, false);
}

/**
 * Encode a key array to its order-preserving byte form: `memcmp` over
 * encodings equals element-wise key order (type rank first, then value,
 * shorter key before its extensions). Throws `TypeError` on `NaN` and on
 * bigints outside signed-64-bit range.
 */
export function encodeKvKey(key: KvKey): Uint8Array {
  const out: number[] = [];
  for (const part of key) {
    if (part instanceof Uint8Array) {
      out.push(TAG_BYTES);
      pushEscaped(out, part);
    } else if (typeof part === "string") {
      out.push(TAG_STRING);
      pushEscaped(out, new TextEncoder().encode(part));
    } else if (typeof part === "number") {
      if (Number.isNaN(part)) {
        throw new TypeError("NaN is not encodable as a KV key part");
      }
      out.push(TAG_NUMBER);
      pushUint64(out, numberToOrderedBits(part));
    } else if (typeof part === "bigint") {
      if (part < -BIGINT_OFFSET || part >= BIGINT_OFFSET) {
        throw new TypeError(
          "bigint KV key parts must fit in a signed 64-bit integer",
        );
      }
      out.push(TAG_BIGINT);
      pushUint64(out, part + BIGINT_OFFSET);
    } else {
      out.push(TAG_BOOLEAN);
      out.push(part ? 0x01 : 0x00);
    }
  }
  return Uint8Array.from(out);
}

function readEscaped(
  bytes: Uint8Array,
  offset: number,
): { payload: Uint8Array; next: number } {
  const payload: number[] = [];
  let i = offset;
  for (;;) {
    const byte = bytes[i];
    if (byte === undefined) {
      throw new TypeError("truncated KV key encoding");
    }
    i += 1;
    if (byte !== 0x00) {
      payload.push(byte);
      continue;
    }
    if (bytes[i] === 0xff) {
      payload.push(0x00);
      i += 1;
      continue;
    }
    return { payload: Uint8Array.from(payload), next: i };
  }
}

function readUint64(bytes: Uint8Array, offset: number): bigint {
  let bits = 0n;
  for (let i = 0; i < 8; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined) {
      throw new TypeError("truncated KV key encoding");
    }
    bits = (bits << 8n) | BigInt(byte);
  }
  return bits;
}

/** Decode {@link encodeKvKey}'s output back to the key array. */
export function decodeKvKey(bytes: Uint8Array): KvKeyPart[] {
  const parts: KvKeyPart[] = [];
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i];
    i += 1;
    switch (tag) {
      case TAG_BYTES: {
        const { payload, next } = readEscaped(bytes, i);
        parts.push(payload);
        i = next;
        break;
      }
      case TAG_STRING: {
        const { payload, next } = readEscaped(bytes, i);
        parts.push(new TextDecoder().decode(payload));
        i = next;
        break;
      }
      case TAG_NUMBER:
        parts.push(orderedBitsToNumber(readUint64(bytes, i)));
        i += 8;
        break;
      case TAG_BIGINT:
        parts.push(readUint64(bytes, i) - BIGINT_OFFSET);
        i += 8;
        break;
      case TAG_BOOLEAN:
        parts.push(bytes[i] === 0x01);
        i += 1;
        break;
      default:
        throw new TypeError(
          `invalid KV key encoding tag 0x${tag?.toString(16)}`,
        );
    }
  }
  return parts;
}

/* ---------- the store ---------- */

const SCHEMA_SQL = [
  "CREATE TABLE IF NOT EXISTS kv (k BLOB PRIMARY KEY, v TEXT NOT NULL, ver INTEGER NOT NULL, expires_at INTEGER);",
  "CREATE TABLE IF NOT EXISTS kv_meta (id INTEGER PRIMARY KEY CHECK (id = 0), seq INTEGER NOT NULL, ok INTEGER NOT NULL);",
  "INSERT OR IGNORE INTO kv_meta (id, seq, ok) VALUES (0, 0, 0);",
].join("\n");

/** A row is live when it has no TTL or its TTL has not elapsed. */
const LIVE = "(expires_at IS NULL OR expires_at > ?)";

/** Versionstamps are the store-wide sequence, padded like `Deno.Kv`'s. */
function toVersionstamp(seq: unknown): string {
  return String(seq).padStart(20, "0");
}

export interface LibsqlKvOptions {
  /** Clock for TTL bookkeeping (`expireIn`, liveness filters, the sweep);
   *  injectable for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface KvOp {
  readonly type: "set" | "delete";
  readonly key: KvKey;
  readonly value?: unknown;
  readonly expireIn?: number;
}

/**
 * `DenoKvLike` over an injected libSQL client — see the module doc comment
 * for the design. The schema is created lazily on first use; construction
 * performs no I/O.
 */
export class LibsqlKv implements DenoKvLike {
  readonly #client: LibsqlClientLike;
  readonly #now: () => number;
  #schema: Promise<void> | undefined;

  constructor(client: LibsqlClientLike, options: LibsqlKvOptions = {}) {
    this.#client = client;
    this.#now = options.now ?? Date.now;
  }

  #ready(): Promise<void> {
    this.#schema ??= this.#client.executeMultiple(SCHEMA_SQL);
    return this.#schema;
  }

  async get<T = unknown>(key: KvKey): Promise<DenoKvEntryLike<T>> {
    await this.#ready();
    const result = await this.#client.execute({
      sql: `SELECT v, ver FROM kv WHERE k = ? AND ${LIVE}`,
      args: [encodeKvKey(key), this.#now()],
    });
    const row = result.rows[0];
    if (row === undefined) {
      return { key, value: null as T, versionstamp: null };
    }
    return {
      key,
      value: JSON.parse(String(row["v"])) as T,
      versionstamp: toVersionstamp(row["ver"]),
    };
  }

  async set(
    key: KvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<{ versionstamp: string }> {
    const result = await this.atomic().set(key, value, options).commit();
    if (!result.ok || result.versionstamp === undefined) {
      throw new Error("LibsqlKv.set: unconditional commit failed");
    }
    return { versionstamp: result.versionstamp };
  }

  async delete(key: KvKey): Promise<void> {
    await this.#ready();
    await this.#client.execute({
      sql: "DELETE FROM kv WHERE k = ?",
      args: [encodeKvKey(key)],
    });
  }

  async *list<T = unknown>(
    selector: DenoKvListSelectorLike,
    options?: { limit?: number },
  ): AsyncIterableIterator<DenoKvEntryLike<T>> {
    await this.#ready();
    const prefix = encodeKvKey(selector.prefix);
    // Any key extending the prefix appends an element tag (≤ 0x05 < 0xFF),
    // so `prefix ‖ 0xFF` is a strict upper bound; the prefix-equal key
    // itself is included, matching the seam's reference semantics.
    const upper = Uint8Array.from([...prefix, 0xff]);
    const conditions = ["k >= ?", "k < ?", LIVE];
    const args: SqlValue[] = [prefix, upper, this.#now()];
    if (selector.start !== undefined) {
      conditions.push("k >= ?");
      args.push(encodeKvKey(selector.start));
    }
    if (selector.end !== undefined) {
      conditions.push("k < ?");
      args.push(encodeKvKey(selector.end));
    }
    args.push(options?.limit ?? -1);
    const result = await this.#client.execute({
      sql: `SELECT k, v, ver FROM kv WHERE ${conditions.join(" AND ")} ORDER BY k LIMIT ?`,
      args,
    });
    for (const row of result.rows) {
      yield {
        key: decodeKvKey(row["k"] as Uint8Array),
        value: JSON.parse(String(row["v"])) as T,
        versionstamp: toVersionstamp(row["ver"]),
      };
    }
  }

  atomic(): DenoKvAtomicLike {
    return new LibsqlKvAtomic(this);
  }

  /**
   * Physically remove rows whose TTL has elapsed (they are already invisible
   * to every read path) and return how many were removed. Intended to be
   * called from the host's poll ticks — precise-to-the-ms expiry is not part
   * of the contract, only "expired is never returned."
   */
  async sweepExpired(now?: number): Promise<number> {
    await this.#ready();
    const result = await this.#client.execute({
      sql: "DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?",
      args: [now ?? this.#now()],
    });
    return result.rowsAffected;
  }

  /** @internal commit path shared by {@link LibsqlKvAtomic} and {@link set}. */
  async _commit(
    checks: readonly DenoKvCheckLike[],
    ops: readonly KvOp[],
  ): Promise<DenoKvCommitResultLike> {
    await this.#ready();
    const now = this.#now();

    // Evaluate every check into the scratch row FIRST, then guard every
    // mutation on that stored verdict: checks always see pre-mutation state,
    // and a failed check makes every mutation a no-op — all inside the one
    // transaction `batch(..., "write")` guarantees.
    const guardTerms: string[] = [];
    const guardArgs: SqlValue[] = [];
    for (const check of checks) {
      if (check.versionstamp === null) {
        guardTerms.push(
          `NOT EXISTS (SELECT 1 FROM kv WHERE k = ? AND ${LIVE})`,
        );
        guardArgs.push(encodeKvKey(check.key), now);
      } else {
        guardTerms.push(
          `EXISTS (SELECT 1 FROM kv WHERE k = ? AND ver = ? AND ${LIVE})`,
        );
        guardArgs.push(encodeKvKey(check.key), Number(check.versionstamp), now);
      }
    }
    const guard = guardTerms.length > 0 ? guardTerms.join(" AND ") : "1";

    const statements: LibsqlStatementLike[] = [
      {
        sql: `UPDATE kv_meta SET ok = CASE WHEN ${guard} THEN 1 ELSE 0 END WHERE id = 0`,
        args: guardArgs,
      },
    ];
    const hasSet = ops.some((op) => op.type === "set");
    if (hasSet) {
      statements.push({
        sql: "UPDATE kv_meta SET seq = seq + 1 WHERE id = 0 AND ok = 1",
        args: [],
      });
    }
    for (const op of ops) {
      if (op.type === "set") {
        statements.push({
          sql:
            "INSERT INTO kv (k, v, ver, expires_at) " +
            "SELECT ?, ?, (SELECT seq FROM kv_meta WHERE id = 0), ? " +
            "WHERE (SELECT ok FROM kv_meta WHERE id = 0) = 1 " +
            "ON CONFLICT (k) DO UPDATE SET v = excluded.v, ver = excluded.ver, expires_at = excluded.expires_at",
          args: [
            encodeKvKey(op.key),
            JSON.stringify(op.value ?? null),
            op.expireIn != null ? now + op.expireIn : null,
          ],
        });
      } else {
        statements.push({
          sql: "DELETE FROM kv WHERE k = ? AND (SELECT ok FROM kv_meta WHERE id = 0) = 1",
          args: [encodeKvKey(op.key)],
        });
      }
    }
    statements.push({
      sql: "SELECT ok, seq FROM kv_meta WHERE id = 0",
      args: [],
    });

    const results = await this.#client.batch(statements, "write");
    const verdict = results[results.length - 1]?.rows[0];
    if (verdict === undefined) {
      throw new Error("LibsqlKv: commit verdict row missing");
    }
    if (Number(verdict["ok"]) !== 1) return { ok: false };
    return hasSet
      ? { ok: true, versionstamp: toVersionstamp(verdict["seq"]) }
      : { ok: true };
  }
}

class LibsqlKvAtomic implements DenoKvAtomicLike {
  readonly #kv: LibsqlKv;
  readonly #checks: DenoKvCheckLike[] = [];
  readonly #ops: KvOp[] = [];

  constructor(kv: LibsqlKv) {
    this.#kv = kv;
  }

  check(...checks: DenoKvCheckLike[]): DenoKvAtomicLike {
    this.#checks.push(...checks);
    return this;
  }

  set(
    key: KvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): DenoKvAtomicLike {
    this.#ops.push({ type: "set", key, value, expireIn: options?.expireIn });
    return this;
  }

  delete(key: KvKey): DenoKvAtomicLike {
    this.#ops.push({ type: "delete", key });
    return this;
  }

  commit(): Promise<DenoKvCommitResultLike> {
    return this.#kv._commit(this.#checks, this.#ops);
  }
}
