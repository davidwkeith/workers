/**
 * The Merkle Search Tree (MST) that is an AT Protocol repository's `data` field.
 *
 * An MST is a deterministic map from record keys (`collection/rkey`) to record
 * CIDs: a key's tree *layer* is fixed by the number of leading zero bit-pairs in
 * `SHA-256(key)`, so the tree shape depends only on the set of entries, never on
 * insertion order. That lets this module **rebuild the canonical tree from the
 * full entry set** on each commit — far simpler than incremental node splitting,
 * and trivially correct because the structure is a pure function of its inputs.
 *
 * Nodes serialise to DAG-CBOR as `{ l, e: [{ p, k, v, t }] }` with the
 * key-prefix compression the spec defines. Pure: the only async is SHA-256.
 */

import { decodeCbor, encodeCbor, type CborValue } from "./cbor";
import { CID, DAG_CBOR_CODEC } from "./cid";

/** A record-key → record-CID pair held by the tree. */
export interface MstEntry {
  readonly key: string;
  readonly value: CID;
}

/** The rebuilt tree: its root CID and every node block it produced. */
export interface MstResult {
  readonly root: CID;
  /** Node blocks keyed by CID string, ready to persist or pack into a CAR. */
  readonly blocks: Map<string, Uint8Array>;
}

interface MutableTreeEntry {
  p: number;
  k: Uint8Array;
  v: CID;
  t: CID | null;
}

interface Enriched extends MstEntry {
  readonly layer: number;
  readonly keyBytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The tree layer of a key: the count of leading zero **bit-pairs** in
 * `SHA-256(key)`. Each fully-zero pair adds one; a byte's value bounds how many
 * of its four pairs are zero. This is the canonical AT Protocol formula.
 */
export async function keyLayer(key: string): Promise<number> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(key) as BufferSource),
  );
  let zeros = 0;
  for (const byte of hash) {
    if (byte < 64) zeros++;
    if (byte < 16) zeros++;
    if (byte < 4) zeros++;
    if (byte === 0) zeros++;
    else break;
  }
  return zeros;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function commonPrefixLen(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}

function serializeNode(l: CID | null, entries: MutableTreeEntry[]): CborValue {
  return {
    l,
    e: entries.map((e) => ({ p: e.p, k: e.k, v: e.v, t: e.t })),
  };
}

async function persist(
  node: CborValue,
  blocks: Map<string, Uint8Array>,
): Promise<CID> {
  const bytes = encodeCbor(node);
  const cid = await CID.create(DAG_CBOR_CODEC, bytes);
  blocks.set(cid.toString(), bytes);
  return cid;
}

async function buildNode(
  entries: Enriched[],
  layer: number,
  blocks: Map<string, Uint8Array>,
): Promise<CID> {
  const e: MutableTreeEntry[] = [];
  let left: CID | null = null;
  let pending: Enriched[] = [];
  let prevKey: Uint8Array | null = null;

  const flush = async (): Promise<CID | null> => {
    if (pending.length === 0) return null;
    const sub = await buildSubtree(pending, blocks);
    pending = [];
    return sub;
  };

  for (const entry of entries) {
    if (entry.layer === layer) {
      const subtree = await flush();
      if (e.length === 0) left = subtree;
      else (e[e.length - 1] as MutableTreeEntry).t = subtree;
      const p = prevKey ? commonPrefixLen(prevKey, entry.keyBytes) : 0;
      e.push({ p, k: entry.keyBytes.slice(p), v: entry.value, t: null });
      prevKey = entry.keyBytes;
    } else {
      pending.push(entry);
    }
  }
  const trailing = await flush();
  if (e.length === 0) left = trailing;
  else (e[e.length - 1] as MutableTreeEntry).t = trailing;

  return persist(serializeNode(left, e), blocks);
}

async function buildSubtree(
  entries: Enriched[],
  blocks: Map<string, Uint8Array>,
): Promise<CID> {
  let max = 0;
  for (const entry of entries) if (entry.layer > max) max = entry.layer;
  return buildNode(entries, max, blocks);
}

/** Rebuild the canonical MST for a set of entries, returning root + node blocks. */
export async function buildMst(entries: MstEntry[]): Promise<MstResult> {
  const blocks = new Map<string, Uint8Array>();
  const enriched: Enriched[] = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      keyBytes: encoder.encode(entry.key),
      layer: await keyLayer(entry.key),
    })),
  );
  enriched.sort((a, b) => compareBytes(a.keyBytes, b.keyBytes));
  if (enriched.length === 0) {
    const root = await persist(serializeNode(null, []), blocks);
    return { root, blocks };
  }
  let topLayer = 0;
  for (const entry of enriched)
    if (entry.layer > topLayer) topLayer = entry.layer;
  const root = await buildNode(enriched, topLayer, blocks);
  return { root, blocks };
}

interface DecodedEntry {
  readonly p: number;
  readonly k: Uint8Array;
  readonly v: CID;
  readonly t: CID | null;
}

function decodeNode(bytes: Uint8Array): { l: CID | null; e: DecodedEntry[] } {
  const node = decodeCbor(bytes) as { l: CID | null; e: unknown[] };
  const e = node.e.map((raw) => {
    const obj = raw as { p: number; k: Uint8Array; v: CID; t: CID | null };
    return { p: obj.p, k: obj.k, v: obj.v, t: obj.t };
  });
  return { l: node.l, e };
}

/**
 * Walk every entry in key order, resolving node blocks through `getBlock`.
 * Reconstructs each full key from its compressed `p`/`k` prefix form. Used to
 * verify a rebuilt tree round-trips and to read a repository back from blocks.
 */
export async function walkEntries(
  root: CID,
  getBlock: (cid: CID) => Uint8Array | undefined,
): Promise<MstEntry[]> {
  const out: MstEntry[] = [];
  const visit = async (cid: CID, prefix: Uint8Array): Promise<void> => {
    const bytes = getBlock(cid);
    if (!bytes) throw new Error(`mst: missing block ${cid.toString()}`);
    const { l, e } = decodeNode(bytes);
    if (l) await visit(l, new Uint8Array(0));
    let prev = prefix;
    for (const entry of e) {
      const keyBytes = new Uint8Array(entry.p + entry.k.length);
      keyBytes.set(prev.slice(0, entry.p), 0);
      keyBytes.set(entry.k, entry.p);
      out.push({ key: decoder.decode(keyBytes), value: entry.v });
      prev = keyBytes;
      if (entry.t) await visit(entry.t, new Uint8Array(0));
    }
  };
  await visit(root, new Uint8Array(0));
  return out;
}
