/**
 * Mastodon-shaped snowflake IDs for phase-2 inbox-derived entries
 * (spec/mastodon-client-api.md Decision 3): `(receivedAtMs << 16) |
 * (source << 15) | (seq & 0x7FFF)`, rendered as a decimal string. `source`
 * is reserved (always `0` — inbox rows only in v1; phase 3 reserves `1` for
 * outbox-derived rows without changing already-persisted IDs). The low 15
 * bits of `seq` only break same-millisecond ties — they are NOT a lossless
 * encoding of a DO's `seq` column, so decoding recovers `receivedAtMs`
 * exactly but only `seq mod 32768`. Callers needing the exact row use
 * `receivedAtMs` as the primary key and the low bits only to disambiguate
 * a same-millisecond collision (see the activitypub adapter).
 */

const SEQ_BITS = 16n; // 1 source bit + 15 sequence bits
const SEQ_MASK = 0x7fffn;

export function encodeSnowflake(receivedAtMs: number, seq: number): string {
  const ms = BigInt(Math.trunc(receivedAtMs));
  const low = BigInt(Math.trunc(seq)) & SEQ_MASK; // source bit 0 = inbox
  return ((ms << SEQ_BITS) | low).toString(10);
}

export interface DecodedSnowflake {
  readonly receivedAtMs: number;
  readonly seqLow: number;
}

export function decodeSnowflake(id: string): DecodedSnowflake | null {
  if (!/^\d+$/.test(id)) return null;
  let value: bigint;
  try {
    value = BigInt(id);
  } catch {
    return null;
  }
  const seqLow = Number(value & SEQ_MASK);
  const receivedAtMs = Number(value >> SEQ_BITS);
  if (!Number.isSafeInteger(receivedAtMs)) return null;
  return { receivedAtMs, seqLow };
}
