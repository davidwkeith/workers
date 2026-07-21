/**
 * CARv1 (Content Addressable aRchive) read/write — the container format AT
 * Protocol uses to export and sync an entire repository (`com.atproto.sync.*`).
 *
 * A CAR is a varint-length-prefixed DAG-CBOR header (`{ roots, version: 1 }`)
 * followed by a sequence of `varint(len) ‖ CID ‖ block` records. That is the
 * whole format — it is just a self-describing bag of content-addressed blocks
 * with a declared root, which is exactly how a repository travels between hosts.
 * Pure byte assembly; no Workers runtime needed.
 */

import { concatBytes } from "./bytes.js";
import { decodeCbor, encodeCbor } from "./cbor.js";
import { CID } from "./cid.js";
import { decodeVarint, encodeVarint } from "./varint.js";

/** One content-addressed block in a CAR. */
export interface CarBlock {
  readonly cid: CID;
  readonly bytes: Uint8Array;
}

function lengthPrefixed(body: Uint8Array): Uint8Array {
  return concatBytes([encodeVarint(body.length), body]);
}

/** The length-prefixed CARv1 header declaring `roots` (§ container-level framing). */
export function encodeCarHeader(roots: CID[]): Uint8Array {
  return lengthPrefixed(
    encodeCbor({ roots: roots.map((cid) => cid), version: 1 }),
  );
}

/** One length-prefixed `CID ‖ block` CARv1 record. */
export function encodeCarBlock(block: CarBlock): Uint8Array {
  return lengthPrefixed(concatBytes([block.cid.bytes, block.bytes]));
}

/**
 * Serialise a CARv1 with `roots` as its declared roots and `blocks` as its body.
 * The caller is responsible for including every block transitively reachable
 * from the roots. Buffers the whole result — fine for the small, bounded CARs
 * this is used for (per-commit firehose diffs, migration import/export); a
 * full repository export streams instead (see `#getRepo` in `object.ts`) so it
 * never holds every record's bytes in memory at once.
 */
export function writeCar(roots: CID[], blocks: Iterable<CarBlock>): Uint8Array {
  const chunks: Uint8Array[] = [encodeCarHeader(roots)];
  for (const block of blocks) {
    chunks.push(encodeCarBlock(block));
  }
  return concatBytes(chunks);
}

/** A parsed CAR: its declared roots and the blocks it carried. */
export interface ParsedCar {
  readonly roots: CID[];
  readonly blocks: CarBlock[];
}

/** Parse a CARv1 buffer back into its roots and blocks. */
export function readCar(bytes: Uint8Array): ParsedCar {
  let pos = 0;
  const headerLen = decodeVarint(bytes, pos);
  pos += headerLen.bytesRead;
  const header = decodeCbor(bytes.slice(pos, pos + headerLen.value)) as {
    roots: CID[];
    version: number;
  };
  pos += headerLen.value;
  if (header.version !== 1) {
    throw new Error(`car: unsupported version ${header.version}`);
  }
  const blocks: CarBlock[] = [];
  while (pos < bytes.length) {
    const len = decodeVarint(bytes, pos);
    pos += len.bytesRead;
    const end = pos + len.value;
    const { cid, end: cidEnd } = CID.decodeFirst(bytes, pos);
    blocks.push({ cid, bytes: bytes.slice(cidEnd, end) });
    pos = end;
  }
  return { roots: header.roots, blocks };
}
