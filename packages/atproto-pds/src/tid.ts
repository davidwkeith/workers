/**
 * TID (timestamp identifier) generation — the sortable 13-character record keys
 * and commit revisions AT Protocol uses. A TID packs a 53-bit microsecond
 * timestamp and a 10-bit random clock identifier into 64 bits (top bit always
 * 0) and renders it in big-endian base32-sortable, so lexicographic order equals
 * chronological order.
 *
 * Pure aside from the injectable clock. A {@link TidClock} keeps issuance
 * strictly monotonic within a process so two records minted in the same
 * microsecond still get distinct, ordered keys.
 */

const S32_CHARS = "234567abcdefghijklmnopqrstuvwxyz";

/** Encode a non-negative integer as a 13-char base32-sortable TID string. */
export function encodeTid(timestampMicros: number, clockId: number): string {
  // 53-bit timestamp in the high bits, 10-bit clock id in the low bits.
  let value = BigInt(timestampMicros) * 1024n + BigInt(clockId & 0x3ff);
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = (S32_CHARS[Number(value & 0x1fn)] as string) + out;
    value >>= 5n;
  }
  return out;
}

/** Whether a string is a syntactically valid TID (13 base32-sortable chars). */
export function isValidTid(tid: string): boolean {
  return /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/.test(tid);
}

/**
 * A monotonic TID source. Each {@link TidClock.next} returns a TID strictly
 * greater than the previous one, even under a coarse or repeated clock reading.
 */
export class TidClock {
  #last = 0;
  readonly #clockId: number;
  readonly #now: () => number;

  constructor(options: { clockId?: number; now?: () => number } = {}) {
    // 10-bit random clock id distinguishes concurrent writers.
    this.#clockId = options.clockId ?? Math.floor(Math.random() * 1024);
    this.#now = options.now ?? (() => Date.now());
  }

  /** Mint the next strictly-increasing TID. */
  next(): string {
    // Date.now() is millisecond-resolution; scale to microseconds and force
    // monotonicity so a burst of writes in one tick still strictly increases.
    let micros = Math.floor(this.#now() * 1000);
    if (micros <= this.#last) micros = this.#last + 1;
    this.#last = micros;
    return encodeTid(micros, this.#clockId);
  }
}
