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
 * - only `null`, booleans, and float64 inhabit major type 7.
 *
 * Determinism is the whole point: the same data must always produce the same
 * bytes, because those bytes are hashed into the content address. Pure — no
 * Workers runtime needed.
 */

import { CID } from "./cid";

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
    // float64 (major 7, additional info 27).
    const buf = new Uint8Array(9);
    buf[0] = (MAJOR.simple << 5) | 27;
    new DataView(buf.buffer).setFloat64(1, value);
    out.push(buf);
    return;
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

function readUint(reader: Reader, info: number): number {
  if (info < 24) return info;
  const { bytes } = reader;
  if (info === 24) return bytes[reader.pos++] as number;
  if (info === 25) {
    const v =
      ((bytes[reader.pos] as number) << 8) | (bytes[reader.pos + 1] as number);
    reader.pos += 2;
    return v;
  }
  if (info === 26) {
    const v =
      (bytes[reader.pos] as number) * 0x1000000 +
      ((bytes[reader.pos + 1] as number) << 16) +
      ((bytes[reader.pos + 2] as number) << 8) +
      (bytes[reader.pos + 3] as number);
    reader.pos += 4;
    return v;
  }
  if (info === 27) {
    let v = 0n;
    for (let i = 0; i < 8; i++)
      v = (v << 8n) | BigInt(bytes[reader.pos + i] as number);
    reader.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("dag-cbor: integer exceeds MAX_SAFE_INTEGER");
    }
    return Number(v);
  }
  throw new Error(`dag-cbor: unsupported additional info ${info}`);
}

function readValue(reader: Reader): CborValue {
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
      const slice = reader.bytes.slice(reader.pos, reader.pos + len);
      reader.pos += len;
      return slice;
    }
    case MAJOR.string: {
      const len = readUint(reader, info);
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
      for (let i = 0; i < len; i++) {
        const key = readValue(reader);
        if (typeof key !== "string") {
          throw new Error("dag-cbor: map keys must be strings");
        }
        obj[key] = readValue(reader);
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
      if (info === 27) {
        const view = new DataView(
          reader.bytes.buffer,
          reader.bytes.byteOffset + reader.pos,
          8,
        );
        reader.pos += 8;
        return view.getFloat64(0);
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
