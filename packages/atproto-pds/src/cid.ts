/**
 * CIDv1 (content identifier) support, scoped to exactly the two codecs AT
 * Protocol repositories use: `dag-cbor` (0x71) for commits, MST nodes, and
 * records, and `raw` (0x55) for blobs. Every multihash is SHA-256, so the hash
 * is computed with WebCrypto (`crypto.subtle.digest`) — no `node:crypto`, no
 * external multiformats dependency.
 *
 * A CID's binary form is `<version=0x01> <codec> <multihash>` where the
 * multihash is `<0x12 sha2-256> <0x20 length> <32-byte digest>`. The string form
 * is multibase base32-lower (`b…`). This module is pure data + one async hash.
 */

import {
  base32Decode,
  base32Encode,
  bytesEqual,
  concatBytes,
} from "./bytes.js";
import { decodeVarint, encodeVarint } from "./varint.js";

/** Multicodec content type for DAG-CBOR blocks (commits, MST nodes, records). */
export const DAG_CBOR_CODEC = 0x71;
/** Multicodec content type for raw blocks (blob bodies). */
export const RAW_CODEC = 0x55;

const SHA2_256 = 0x12;
const SHA2_256_LENGTH = 0x20;
const CIDV1 = 0x01;
/** Multibase prefix for base32-lower, the canonical CID string encoding. */
const BASE32_MULTIBASE = "b";

/**
 * A content identifier. Instances are immutable value objects compared by their
 * bytes; {@link CID.toString} yields the canonical base32 form used everywhere a
 * CID appears as text (record keys, JSON link objects, did docs).
 */
export class CID {
  /** Full CIDv1 binary encoding. */
  readonly bytes: Uint8Array;
  /** The multicodec of the addressed block (`dag-cbor` or `raw`). */
  readonly codec: number;

  constructor(bytes: Uint8Array, codec: number) {
    this.bytes = bytes;
    this.codec = codec;
  }

  /** Hash `data` under `codec` and build its CIDv1. */
  static async create(codec: number, data: Uint8Array): Promise<CID> {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", data as BufferSource),
    );
    const bytes = concatBytes([
      encodeVarint(CIDV1),
      encodeVarint(codec),
      Uint8Array.from([SHA2_256, SHA2_256_LENGTH]),
      digest,
    ]);
    return new CID(bytes, codec);
  }

  /**
   * Decode the first CID at `offset`, returning it and the byte offset just past
   * it — used by the CAR reader, where a CID is immediately followed by its
   * block body with no length prefix of its own.
   */
  static decodeFirst(bytes: Uint8Array, offset = 0): { cid: CID; end: number } {
    let cursor = offset;
    const version = decodeVarint(bytes, cursor);
    if (version.value !== CIDV1) {
      throw new Error(`cid: unsupported version ${version.value}`);
    }
    cursor += version.bytesRead;
    const codec = decodeVarint(bytes, cursor);
    cursor += codec.bytesRead;
    const hashCode = decodeVarint(bytes, cursor);
    cursor += hashCode.bytesRead;
    if (hashCode.value !== SHA2_256) {
      throw new Error(
        `cid: unsupported multihash 0x${hashCode.value.toString(16)}`,
      );
    }
    const hashLen = decodeVarint(bytes, cursor);
    cursor += hashLen.bytesRead;
    const end = cursor + hashLen.value;
    if (end > bytes.length) throw new Error("cid: truncated multihash");
    return { cid: new CID(bytes.slice(offset, end), codec.value), end };
  }

  /** Decode a standalone CID from its exact byte encoding. */
  static decode(bytes: Uint8Array): CID {
    const { cid, end } = CID.decodeFirst(bytes, 0);
    if (end !== bytes.length) throw new Error("cid: trailing bytes");
    return cid;
  }

  /** Parse a base32 (`b…`) CID string. */
  static parse(text: string): CID {
    if (text[0] !== BASE32_MULTIBASE) {
      throw new Error(`cid: unsupported multibase prefix ${text[0]}`);
    }
    return CID.decode(base32Decode(text.slice(1)));
  }

  /** Canonical base32-lower multibase string. */
  toString(): string {
    return BASE32_MULTIBASE + base32Encode(this.bytes);
  }

  equals(other: CID): boolean {
    return bytesEqual(this.bytes, other.bytes);
  }
}
