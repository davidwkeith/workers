/**
 * A minimal CBOR (RFC 8949) decoder — only the subset WebAuthn needs.
 *
 * Two WebAuthn structures are CBOR: the attestation object (a string-keyed map
 * wrapping `fmt` / `attStmt` / `authData`) and the credential public key (a
 * COSE_Key, an integer-keyed map). Decoding those needs unsigned and negative
 * integers, byte and text strings, arrays, and maps — nothing else. We
 * deliberately do **not** pull a general CBOR library: the script-size budget is
 * tight (see `spec/non-functional-requirements.md`) and a focused decoder is
 * easy to audit.
 *
 * Maps decode to `Map` so integer COSE labels survive as keys (a plain object
 * would coerce them to strings and collide negative/positive labels by string
 * form). The decoder reports how many bytes it consumed so a caller can locate
 * the bytes that follow a variable-length structure (the COSE key embedded in
 * authenticator data is followed by optional extension bytes).
 */

/** A decoded CBOR value (the subset this decoder produces). */
export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>;

/** A decoded value together with the number of input bytes it consumed. */
export interface CborDecoded {
  readonly value: CborValue;
  readonly length: number;
}

/** Thrown when the input is not valid CBOR (or uses an unsupported feature). */
export class CborError extends Error {}

/**
 * Decode the first CBOR data item starting at `start`. Returns the value and
 * the number of bytes consumed; trailing bytes are ignored (the caller decides
 * whether they are allowed).
 */
export function decodeFirst(bytes: Uint8Array, start = 0): CborDecoded {
  const reader = new Reader(bytes, start);
  const value = reader.readItem();
  return { value, length: reader.offset - start };
}

class Reader {
  offset: number;
  readonly #bytes: Uint8Array;
  readonly #view: DataView;

  constructor(bytes: Uint8Array, start: number) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = start;
  }

  readItem(): CborValue {
    const initial = this.#byte();
    const major = initial >> 5;
    const info = initial & 0x1f;

    switch (major) {
      case 0: // unsigned integer
        return this.#argument(info);
      case 1: {
        // negative integer: encodes -(n + 1)
        const n = this.#argument(info);
        return typeof n === "bigint" ? -(n + 1n) : -(n + 1);
      }
      case 2: // byte string
        return this.#bytesOfLength(this.#lengthArgument(info));
      case 3: // text string
        return new TextDecoder().decode(
          this.#bytesOfLength(this.#lengthArgument(info)),
        );
      case 4: {
        // array
        const len = this.#lengthArgument(info);
        const items: CborValue[] = [];
        for (let i = 0; i < len; i++) items.push(this.readItem());
        return items;
      }
      case 5: {
        // map
        const len = this.#lengthArgument(info);
        const map = new Map<CborValue, CborValue>();
        for (let i = 0; i < len; i++) {
          const key = this.readItem();
          map.set(key, this.readItem());
        }
        return map;
      }
      default:
        // Tags (6) and simple/float (7) are not used by the WebAuthn subset.
        throw new CborError(`unsupported CBOR major type ${major}`);
    }
  }

  /** Read the integer argument that follows the initial byte. */
  #argument(info: number): number | bigint {
    if (info < 24) return info;
    switch (info) {
      case 24:
        return this.#byte();
      case 25: {
        this.#need(2);
        const v = this.#view.getUint16(this.offset);
        this.offset += 2;
        return v;
      }
      case 26: {
        this.#need(4);
        const v = this.#view.getUint32(this.offset);
        this.offset += 4;
        return v;
      }
      case 27: {
        this.#need(8);
        const v = this.#view.getBigUint64(this.offset);
        this.offset += 8;
        // Collapse to a number when it fits, so callers compare with `===`.
        return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
      default:
        // 28-30 are reserved; 31 (indefinite length) is unsupported here.
        throw new CborError(`unsupported CBOR additional info ${info}`);
    }
  }

  /** Like {@link #argument} but as a JS number bounded for use as a length. */
  #lengthArgument(info: number): number {
    const value = this.#argument(info);
    if (typeof value === "bigint" || value > this.#bytes.length) {
      throw new CborError("CBOR length out of range");
    }
    return value;
  }

  #byte(): number {
    if (this.offset >= this.#bytes.length) {
      throw new CborError("unexpected end of CBOR input");
    }
    return this.#bytes[this.offset++]!;
  }

  /**
   * Assert `n` more bytes are available before a multi-byte read. Without this,
   * a truncated argument would let `DataView` throw a native `RangeError` that
   * escapes the `CborError` contract callers rely on.
   */
  #need(n: number): void {
    if (this.offset + n > this.#bytes.length) {
      throw new CborError("unexpected end of CBOR input");
    }
  }

  #bytesOfLength(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.#bytes.length) {
      throw new CborError("unexpected end of CBOR input");
    }
    const slice = this.#bytes.subarray(this.offset, end);
    this.offset = end;
    return slice;
  }
}
