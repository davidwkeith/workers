/**
 * Minimal unsigned LEB128 varint codec.
 *
 * Pure and protocol-agnostic within the package: CIDs (codec / multihash code +
 * length) and the CAR container framing are both length-prefixed with unsigned
 * varints. Only the unsigned form is needed — AT Protocol never uses signed
 * varints — so this stays deliberately small.
 */

/** Encode a non-negative integer as an unsigned LEB128 varint. */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`varint: cannot encode ${value}`);
  }
  const out: number[] = [];
  let n = value;
  // 7 bits per byte, low byte first, high bit set on every byte but the last.
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return Uint8Array.from(out);
}

/** A decoded varint together with the number of bytes it consumed. */
export interface DecodedVarint {
  readonly value: number;
  readonly bytesRead: number;
}

/** Decode an unsigned LEB128 varint starting at `offset`. */
export function decodeVarint(bytes: Uint8Array, offset = 0): DecodedVarint {
  let value = 0;
  let shift = 1;
  let i = offset;
  for (;;) {
    if (i >= bytes.length) {
      throw new Error("varint: truncated input");
    }
    const byte = bytes[i] as number;
    value += (byte & 0x7f) * shift;
    i += 1;
    if ((byte & 0x80) === 0) break;
    shift *= 0x80;
    if (shift > Number.MAX_SAFE_INTEGER) {
      throw new Error("varint: value exceeds MAX_SAFE_INTEGER");
    }
  }
  return { value, bytesRead: i - offset };
}
