/**
 * Bitstring Status List support: the encoded-list codec, credential/entry
 * builders, and a D1-backed authority for flipping a credential's status.
 *
 * A status list is a GZIP-compressed bitstring, multibase base64url-encoded,
 * published inside a `BitstringStatusListCredential`. A credential opts in by
 * carrying a `BitstringStatusListEntry` that points at a list and an index;
 * verifiers read the bit at that index. Flipping a bit (revoking, suspending) is
 * stateful and security-sensitive, so the authoritative bits live in **D1** — a
 * strongly-consistent store — never KV (see `spec/non-functional-requirements.md`).
 *
 * The codec and builders are pure (GZIP via `CompressionStream`, available under
 * both Node and workerd); only {@link createVcStatusStore} touches a binding.
 *
 * @see https://www.w3.org/TR/vc-bitstring-status-list/
 */

import type { JcsValue } from "./jcs";
import type { JsonObject } from "./data-integrity";
import { decodeMultibase, encodeMultibaseBase64url } from "./multibase";

/**
 * The minimum bitstring length the spec mandates (131,072 bits / 16 KB), chosen
 * so an individual entry's index does not leak which credential it refers to.
 */
export const DEFAULT_STATUS_LIST_LENGTH = 131072;

export const BITSTRING_STATUS_LIST_CREDENTIAL_TYPE =
  "BitstringStatusListCredential";
export const BITSTRING_STATUS_LIST_ENTRY_TYPE = "BitstringStatusListEntry";
export const BITSTRING_STATUS_LIST_SUBJECT_TYPE = "BitstringStatusList";

/** A status purpose. `revocation` is permanent; `suspension` is reversible. */
export type StatusPurpose = "revocation" | "suspension" | (string & {});

/** Get the bit at `index` in a most-significant-bit-first bitstring. */
export function getBit(bits: Uint8Array, index: number): boolean {
  const byteIndex = index >> 3;
  if (byteIndex >= bits.length) return false;
  const bit = 7 - (index & 7);
  return ((bits[byteIndex]! >> bit) & 1) === 1;
}

/** Set the bit at `index` in a most-significant-bit-first bitstring. */
export function setBit(bits: Uint8Array, index: number, value: boolean): void {
  const byteIndex = index >> 3;
  if (byteIndex >= bits.length) {
    throw new Error(`@dwk/vc: status index ${index} is out of range`);
  }
  const bit = 7 - (index & 7);
  if (value) {
    bits[byteIndex]! |= 1 << bit;
  } else {
    bits[byteIndex]! &= ~(1 << bit);
  }
}

async function gzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  void writer.write(input as unknown as BufferSource);
  void writer.close();
  const compressed = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(compressed);
}

async function gunzip(input: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  void writer.write(input as unknown as BufferSource);
  void writer.close();
  const decompressed = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(decompressed);
}

/** GZIP-compress a bitstring and multibase base64url-encode it (`encodedList`). */
export async function encodeBitstring(bits: Uint8Array): Promise<string> {
  return encodeMultibaseBase64url(await gzip(bits));
}

/** Decode an `encodedList` (multibase base64url + GZIP) back to its bitstring. */
export async function decodeBitstring(
  encodedList: string,
): Promise<Uint8Array> {
  return gunzip(decodeMultibase(encodedList));
}

/**
 * Build an `encodedList` of `length` bits with the given indices set to 1.
 * `length` is the bit count (rounded up to whole bytes).
 */
export async function buildEncodedList(
  setIndices: Iterable<number>,
  length: number = DEFAULT_STATUS_LIST_LENGTH,
): Promise<string> {
  const bits = new Uint8Array(Math.ceil(length / 8));
  for (const index of setIndices) setBit(bits, index, true);
  return encodeBitstring(bits);
}

/** Options for {@link buildStatusListCredential}. */
export interface StatusListCredentialOptions {
  /** The status list credential's id (a URL). */
  readonly id: string;
  /** The status purpose this list tracks. */
  readonly statusPurpose: StatusPurpose;
  /** The pre-built `encodedList` value. */
  readonly encodedList: string;
  /** The issuer (string or object with id). */
  readonly issuer: string | (JsonObject & { id: string });
  /** Bit length advertised on the subject. Defaults to the encoded length. */
  readonly ttl?: number;
}

/**
 * Assemble an **unsigned** `BitstringStatusListCredential`. The caller signs it
 * with {@link ./data-integrity.addProof} before publishing.
 */
export function buildStatusListCredential(
  options: StatusListCredentialOptions,
): JsonObject {
  const subject: JsonObject = {
    id: `${options.id}#list`,
    type: BITSTRING_STATUS_LIST_SUBJECT_TYPE,
    statusPurpose: options.statusPurpose,
    encodedList: options.encodedList,
  };
  if (options.ttl !== undefined) subject.ttl = options.ttl;
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    id: options.id,
    type: ["VerifiableCredential", BITSTRING_STATUS_LIST_CREDENTIAL_TYPE],
    issuer: options.issuer,
    validFrom: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    credentialSubject: subject,
  };
}

/** Build a `credentialStatus` entry referencing a list index. */
export function buildStatusEntry(options: {
  readonly statusListCredential: string;
  readonly statusListIndex: number;
  readonly statusPurpose: StatusPurpose;
  readonly id?: string;
}): JsonObject {
  return {
    id:
      options.id ??
      `${options.statusListCredential}#${options.statusListIndex}`,
    type: BITSTRING_STATUS_LIST_ENTRY_TYPE,
    statusPurpose: options.statusPurpose,
    statusListIndex: String(options.statusListIndex),
    statusListCredential: options.statusListCredential,
  };
}

/** Read a `statusListIndex` from a credential's `credentialStatus` entry. */
export function statusEntryIndex(entry: JsonObject): number | undefined {
  const raw = entry.statusListIndex;
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Locate a `credentialStatus` entry for a purpose on a credential. */
export function findStatusEntry(
  credential: JsonObject,
  statusPurpose: StatusPurpose,
): JsonObject | undefined {
  const status = credential.credentialStatus;
  const entries: JcsValue[] = Array.isArray(status)
    ? status
    : status === undefined
      ? []
      : [status];
  for (const entry of entries) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as JsonObject).statusPurpose === statusPurpose
    ) {
      return entry as JsonObject;
    }
  }
  return undefined;
}

/** Cloudflare bindings required by the D1-backed status store. */
export interface VcStatusStoreEnv {
  /** D1 database holding per-list status bits and index allocations. */
  readonly VC_STATUS_DB: D1Database;
}

/** Authoritative store for credential status bits, backed by D1. */
export interface VcStatusStore {
  /** Create the schema if absent. Idempotent. */
  init(): Promise<void>;
  /** Allocate and return the next unused index for a list + purpose. */
  allocateIndex(listId: string, statusPurpose: StatusPurpose): Promise<number>;
  /** Set the status bit at an index (e.g. revoke). */
  setStatus(
    listId: string,
    statusPurpose: StatusPurpose,
    index: number,
    value: boolean,
  ): Promise<void>;
  /** Read the status bit at an index (defaults to `false`/unset). */
  getStatus(
    listId: string,
    statusPurpose: StatusPurpose,
    index: number,
  ): Promise<boolean>;
  /** The set (value-1) indices for a list + purpose, ascending. */
  setIndices(listId: string, statusPurpose: StatusPurpose): Promise<number[]>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS status_entries (
     list_id TEXT NOT NULL,
     status_purpose TEXT NOT NULL,
     idx INTEGER NOT NULL,
     value INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (list_id, status_purpose, idx)
   )`,
  `CREATE TABLE IF NOT EXISTS status_allocations (
     list_id TEXT NOT NULL,
     status_purpose TEXT NOT NULL,
     next_index INTEGER NOT NULL,
     PRIMARY KEY (list_id, status_purpose)
   )`,
] as const;

/**
 * Create the D1-backed {@link VcStatusStore}. Fails loudly if the required
 * `VC_STATUS_DB` binding is missing — no silent degradation (composition
 * contract).
 */
export function createVcStatusStore(env: VcStatusStoreEnv): VcStatusStore {
  if (!env.VC_STATUS_DB) {
    throw new Error("@dwk/vc: missing required D1 binding `VC_STATUS_DB`");
  }
  const db = env.VC_STATUS_DB;

  return {
    async init() {
      for (const ddl of SCHEMA) await db.prepare(ddl).run();
    },

    async allocateIndex(listId, statusPurpose) {
      // Atomically bump the per-list counter and read it back, so concurrent
      // allocations never hand out the same index.
      const row = await db
        .prepare(
          `INSERT INTO status_allocations (list_id, status_purpose, next_index)
             VALUES (?, ?, 1)
           ON CONFLICT (list_id, status_purpose)
             DO UPDATE SET next_index = next_index + 1
           RETURNING next_index`,
        )
        .bind(listId, statusPurpose)
        .first<{ next_index: number }>();
      // next_index now points past the allocated slot; the slot is one below.
      return (row?.next_index ?? 1) - 1;
    },

    async setStatus(listId, statusPurpose, index, value) {
      await db
        .prepare(
          `INSERT INTO status_entries (list_id, status_purpose, idx, value)
             VALUES (?, ?, ?, ?)
           ON CONFLICT (list_id, status_purpose, idx)
             DO UPDATE SET value = excluded.value`,
        )
        .bind(listId, statusPurpose, index, value ? 1 : 0)
        .run();
    },

    async getStatus(listId, statusPurpose, index) {
      const row = await db
        .prepare(
          `SELECT value FROM status_entries
           WHERE list_id = ? AND status_purpose = ? AND idx = ?`,
        )
        .bind(listId, statusPurpose, index)
        .first<{ value: number }>();
      return row?.value === 1;
    },

    async setIndices(listId, statusPurpose) {
      const result = await db
        .prepare(
          `SELECT idx FROM status_entries
           WHERE list_id = ? AND status_purpose = ? AND value = 1
           ORDER BY idx ASC`,
        )
        .bind(listId, statusPurpose)
        .all<{ idx: number }>();
      return (result.results ?? []).map((r) => r.idx);
    },
  };
}
