/**
 * Deterministic DAG-CBOR codec — the canonical block encoding for AT Protocol
 * (commits, MST nodes, and records are all DAG-CBOR). This implements exactly
 * the IPLD DAG-CBOR profile the protocol mandates:
 *
 * - integers are minimally encoded and must be safe integers;
 * - map keys must be strings, and are sorted **length-first, then bytewise** on
 *   their UTF-8 bytes (RFC 7049 §3.9 canonical ordering);
 * - {@link CID} links are encoded as tag 42 wrapping a byte string with a
 *   leading 0x00 multibase-identity prefix;
 * - only `null` and booleans inhabit major type 7 — the atproto data model
 *   **forbids floats**, so a non-integer number is rejected on encode and a
 *   float head (major 7, additional info 25/26/27) is rejected on decode.
 *
 * Determinism is the whole point: the same data must always produce the same
 * bytes, because those bytes are hashed into the content address. Decoding is
 * **strict** for the same reason — non-minimal integers and out-of-order or
 * duplicate map keys are non-canonical encodings of the same data, so they would
 * carry a different CID than a re-encode and must be rejected, not silently
 * accepted. Pure — no Workers runtime needed.
 */

import { CID } from "./cid.js";

/** The value model DAG-CBOR can represent in this package. */
export type CborValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | CID
  | CborValue[]
  | { [key: string]: CborValue };

const MAJOR = {
  uint: 0,
  negint: 1,
  bytes: 2,
  string: 3,
  array: 4,
  map: 5,
  tag: 6,
  simple: 7,
} as const;

const CID_TAG = 42;

function encodeHead(major: number, arg: number): Uint8Array {
  const prefix = major << 5;
  if (arg < 24) return Uint8Array.from([prefix | arg]);
  if (arg < 0x100) return Uint8Array.from([prefix | 24, arg]);
  if (arg < 0x10000)
    return Uint8Array.from([prefix | 25, arg >> 8, arg & 0xff]);
  if (arg < 0x100000000) {
    return Uint8Array.from([
      prefix | 26,
      (arg >>> 24) & 0xff,
      (arg >>> 16) & 0xff,
      (arg >>> 8) & 0xff,
      arg & 0xff,
    ]);
  }
  // 64-bit argument: split through BigInt so the high word is exact.
  const big = BigInt(arg);
  const out = new Uint8Array(9);
  out[0] = prefix | 27;
  for (let i = 0; i < 8; i++) {
    out[8 - i] = Number((big >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}

const textEncoder = new TextEncoder();

/** UTF-8 byte length of the keys, for length-first canonical sorting. */
function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

function compareKeyBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Assign a key parsed from untrusted input onto a plain object, guarding the one
 * key — `__proto__` — whose plain assignment would invoke the inherited setter
 * and poison the prototype chain instead of storing an own property. A data
 * descriptor sidesteps the setter; every other key uses ordinary assignment, so
 * the object keeps the standard `Object.prototype` (and methods like
 * `hasOwnProperty`) that consumers of this value model expect.
 */
export function assignKey<T>(
  target: { [key: string]: T },
  key: string,
  value: T,
): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

function encodeValue(value: CborValue, out: Uint8Array[]): void {
  if (value === null) {
    out.push(Uint8Array.from([(MAJOR.simple << 5) | 22]));
    return;
  }
  if (typeof value === "boolean") {
    out.push(Uint8Array.from([(MAJOR.simple << 5) | (value ? 21 : 20)]));
    return;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) {
        throw new Error(`dag-cbor: integer ${value} is not a safe integer`);
      }
      if (value >= 0) out.push(encodeHead(MAJOR.uint, value));
      else out.push(encodeHead(MAJOR.negint, -1 - value));
      return;
    }
    // The atproto data model forbids floats; a non-integer (or non-finite)
    // number has no canonical DAG-CBOR encoding here.
    throw new Error(`dag-cbor: floats are not supported (${value})`);
  }
  if (typeof value === "string") {
    const bytes = utf8(value);
    out.push(encodeHead(MAJOR.string, bytes.length), bytes);
    return;
  }
  if (value instanceof Uint8Array) {
    out.push(encodeHead(MAJOR.bytes, value.length), value);
    return;
  }
  if (value instanceof CID) {
    // tag(42) -> byte string of 0x00 (multibase identity) ++ CID bytes.
    out.push(encodeHead(MAJOR.tag, CID_TAG));
    const body = new Uint8Array(value.bytes.length + 1);
    body[0] = 0x00;
    body.set(value.bytes, 1);
    out.push(encodeHead(MAJOR.bytes, body.length), body);
    return;
  }
  if (Array.isArray(value)) {
    out.push(encodeHead(MAJOR.array, value.length));
    for (const item of value) encodeValue(item, out);
    return;
  }
  // Plain object -> map with canonically sorted string keys.
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ({ k, kb: utf8(k), v }));
  entries.sort((a, b) => compareKeyBytes(a.kb, b.kb));
  out.push(encodeHead(MAJOR.map, entries.length));
  for (const entry of entries) {
    out.push(encodeHead(MAJOR.string, entry.kb.length), entry.kb);
    encodeValue(entry.v, out);
  }
}

/** Encode a value to canonical DAG-CBOR bytes. */
export function encodeCbor(value: CborValue): Uint8Array {
  const chunks: Uint8Array[] = [];
  encodeValue(value, chunks);
  let total = 0;
  for (const c of chunks) total += c.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

const textDecoder = new TextDecoder();

interface Reader {
  readonly bytes: Uint8Array;
  pos: number;
}

/** Assert at least `n` more bytes are available before reading them. */
function need(reader: Reader, n: number): void {
  if (reader.pos + n > reader.bytes.length) {
    throw new Error("dag-cbor: unexpected end of input");
  }
}

/** The argument is non-minimally encoded if it would fit in a shorter form. */
function assertMinimal(value: number | bigint, min: number | bigint): void {
  if (value < min) {
    throw new Error("dag-cbor: integer is not minimally encoded");
  }
}

function readUint(reader: Reader, info: number): number {
  if (info < 24) return info;
  const { bytes } = reader;
  if (info === 24) {
    need(reader, 1);
    const v = bytes[reader.pos++] as number;
    assertMinimal(v, 24);
    return v;
  }
  if (info === 25) {
    need(reader, 2);
    const v =
      ((bytes[reader.pos] as number) << 8) | (bytes[reader.pos + 1] as number);
    reader.pos += 2;
    assertMinimal(v, 0x100);
    return v;
  }
  if (info === 26) {
    need(reader, 4);
    const v =
      (bytes[reader.pos] as number) * 0x1000000 +
      ((bytes[reader.pos + 1] as number) << 16) +
      ((bytes[reader.pos + 2] as number) << 8) +
      (bytes[reader.pos + 3] as number);
    reader.pos += 4;
    assertMinimal(v, 0x10000);
    return v;
  }
  if (info === 27) {
    need(reader, 8);
    let v = 0n;
    for (let i = 0; i < 8; i++)
      v = (v << 8n) | BigInt(bytes[reader.pos + i] as number);
    reader.pos += 8;
    assertMinimal(v, 0x100000000n);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("dag-cbor: integer exceeds MAX_SAFE_INTEGER");
    }
    return Number(v);
  }
  throw new Error(`dag-cbor: unsupported additional info ${info}`);
}

function readValue(reader: Reader): CborValue {
  need(reader, 1);
  const initial = reader.bytes[reader.pos++] as number;
  const major = initial >> 5;
  const info = initial & 0x1f;
  switch (major) {
    case MAJOR.uint:
      return readUint(reader, info);
    case MAJOR.negint:
      return -1 - readUint(reader, info);
    case MAJOR.bytes: {
      const len = readUint(reader, info);
      need(reader, len);
      const slice = reader.bytes.slice(reader.pos, reader.pos + len);
      reader.pos += len;
      return slice;
    }
    case MAJOR.string: {
      const len = readUint(reader, info);
      need(reader, len);
      const slice = reader.bytes.slice(reader.pos, reader.pos + len);
      reader.pos += len;
      return textDecoder.decode(slice);
    }
    case MAJOR.array: {
      const len = readUint(reader, info);
      const arr: CborValue[] = [];
      for (let i = 0; i < len; i++) arr.push(readValue(reader));
      return arr;
    }
    case MAJOR.map: {
      const len = readUint(reader, info);
      const obj: { [key: string]: CborValue } = {};
      let prevKey: Uint8Array | null = null;
      for (let i = 0; i < len; i++) {
        // Read the key's string header directly and take its raw UTF-8 bytes as
        // a view, so the canonical-order check needs neither a decode-to-string
        // nor a re-encode-back — only the eventual key is decoded, once.
        need(reader, 1);
        const keyInitial = reader.bytes[reader.pos++] as number;
        if (keyInitial >> 5 !== MAJOR.string) {
          throw new Error("dag-cbor: map keys must be strings");
        }
        const keyLen = readUint(reader, keyInitial & 0x1f);
        need(reader, keyLen);
        const keyBytes = reader.bytes.subarray(reader.pos, reader.pos + keyLen);
        reader.pos += keyLen;
        // Canonical DAG-CBOR requires map keys in length-first-then-bytewise
        // order with no duplicates; an out-of-order (or repeated) key is a
        // non-canonical encoding of the same map and must be rejected, since it
        // would re-encode to a different CID than the one it arrived under.
        if (prevKey !== null && compareKeyBytes(prevKey, keyBytes) >= 0) {
          throw new Error("dag-cbor: map keys out of order or duplicated");
        }
        prevKey = keyBytes;
        // Decoded blocks are untrusted; guard the `__proto__` key so it becomes
        // an own property rather than poisoning the prototype chain.
        assignKey(obj, textDecoder.decode(keyBytes), readValue(reader));
      }
      return obj;
    }
    case MAJOR.tag: {
      const tag = readUint(reader, info);
      if (tag !== CID_TAG) throw new Error(`dag-cbor: unsupported tag ${tag}`);
      const link = readValue(reader);
      if (!(link instanceof Uint8Array) || link[0] !== 0x00) {
        throw new Error("dag-cbor: malformed CID tag");
      }
      return CID.decode(link.slice(1));
    }
    case MAJOR.simple: {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      // Major-7 additional info 25/26/27 are half/single/double floats. The
      // atproto data model forbids floats, so reject them rather than decode.
      if (info === 25 || info === 26 || info === 27) {
        throw new Error("dag-cbor: floats are not supported");
      }
      throw new Error(`dag-cbor: unsupported simple value ${info}`);
    }
    default:
      throw new Error(`dag-cbor: unsupported major type ${major}`);
  }
}

/** Decode canonical DAG-CBOR bytes back into the value model. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const reader: Reader = { bytes, pos: 0 };
  const value = readValue(reader);
  if (reader.pos !== bytes.length) {
    throw new Error("dag-cbor: trailing bytes after top-level value");
  }
  return value;
}
