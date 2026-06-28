/**
 * Inbound account migration: reading an existing AT Protocol repository out of a
 * CAR export so it can be re-homed onto this PDS.
 *
 * This is the pure, Workers-runtime-free **import core** (#183). The standard
 * migration flow exports the source repository as a CAR
 * (`com.atproto.sync.getRepo` on the old PDS) and imports it here
 * (`com.atproto.repo.importRepo`). This module turns those CAR bytes back into a
 * verified commit plus the flat set of records it carries — without touching the
 * Durable Object, so it unit-tests in isolation. Writing the records into our
 * store, importing referenced blobs, and the account-status cutover are the next
 * increments.
 *
 * The repository is **self-verifying**: the root commit is signed with the
 * source account's repository key (advertised in its DID document), so an import
 * can — and by default should — verify that signature before trusting a single
 * record. The MST is then walked to recover every `collection/rkey → record`
 * entry from the same block bag.
 */

import { readCar } from "./car.js";
import { decodeCbor } from "./cbor.js";
import { CID } from "./cid.js";
import type { SigningCurve } from "./crypto.js";
import { walkEntries } from "./mst.js";
import { cborToJson, type JsonValue } from "./record.js";
import { COMMIT_VERSION, verifyCommit, type SignedCommit } from "./repo.js";
import { isValidNsid, isValidRecordKey } from "./xrpc.js";

/**
 * Validate that a decoded CBOR value is a structurally well-formed signed commit
 * before trusting it. A CAR is untrusted external input, so a malformed root must
 * fail with a clear error rather than a downstream `TypeError`.
 */
function assertSignedCommit(value: unknown): asserts value is SignedCommit {
  const c = value as Record<string, unknown> | null;
  if (
    !c ||
    typeof c !== "object" ||
    typeof c.did !== "string" ||
    typeof c.version !== "number" ||
    !(c.data instanceof CID) ||
    typeof c.rev !== "string" ||
    !(c.prev === null || c.prev instanceof CID) ||
    !(c.sig instanceof Uint8Array)
  ) {
    throw new Error(
      "migrate: root commit is malformed or missing required fields",
    );
  }
}

/** A single record recovered from an imported repository. */
export interface ImportedRecord {
  readonly collection: string;
  readonly rkey: string;
  readonly cid: CID;
  /** The record's canonical DAG-CBOR block, stored verbatim to preserve its CID. */
  readonly bytes: Uint8Array;
  /** The record decoded to JSON, for inspection. */
  readonly value: JsonValue;
}

/** The verified contents of an imported repository CAR. */
export interface ImportedRepo {
  /** The account DID the imported commit claims. */
  readonly did: string;
  /** The imported commit's revision (`rev`). */
  readonly rev: string;
  /** The signed root commit. */
  readonly commit: SignedCommit;
  /** The repository head CID (the signed commit's CID, the CAR root). */
  readonly head: CID;
  /** Whether the root commit signature was verified (false if no key supplied). */
  readonly signatureVerified: boolean;
  /** Every record the repository carries, in MST key order. */
  readonly records: readonly ImportedRecord[];
}

/** The source repository's signing key, to verify the imported commit. */
export interface ImportVerifyKey {
  /** Raw uncompressed (65-byte) public key from the source DID document. */
  readonly publicKeyRaw: Uint8Array;
  /** Its curve (from the key's multicodec). */
  readonly curve: SigningCurve;
}

/** Options for {@link importRepoFromCar}. */
export interface ImportRepoOptions {
  /**
   * The source repository signing key. When given, the root commit signature is
   * verified and a mismatch throws. Omitting it skips verification — only do that
   * when the caller has already authenticated the export some other way.
   */
  readonly verifyKey?: ImportVerifyKey;
}

/**
 * Parse and verify a repository CAR export, recovering its commit and records.
 * Throws if the CAR is malformed, the root commit or a referenced block is
 * missing, the commit version is unsupported, or (when {@link
 * ImportRepoOptions.verifyKey} is given) the signature fails.
 */
export async function importRepoFromCar(
  carBytes: Uint8Array,
  options: ImportRepoOptions = {},
): Promise<ImportedRepo> {
  const { roots, blocks } = readCar(carBytes);
  if (roots.length === 0) {
    throw new Error("migrate: CAR has no root commit");
  }
  const head = roots[0] as CID;

  // A CAR is untrusted external input: its records are only as trustworthy as
  // the chain from the *signed* root commit down to each block. That chain is
  // by content address, so every block must hash to the CID it is filed under —
  // otherwise a tampered CAR could swap MST-node or record bytes under the
  // expected CIDs and the root-commit signature would still "verify" while the
  // recovered records are forged. Recompute and compare each block's CID (every
  // block in a parsed CAR is CIDv1/SHA-256, so `CID.create` reproduces it).
  // Each recompute is an independent async SHA-256, so verify them concurrently
  // rather than serially — a large repo CAR carries thousands of blocks and a
  // sequential `await` per block would dominate import latency.
  const index = new Map<string, Uint8Array>();
  await Promise.all(
    blocks.map(async (block) => {
      const computed = await CID.create(block.cid.codec, block.bytes);
      if (!computed.equals(block.cid)) {
        throw new Error(
          `migrate: CAR block ${block.cid.toString()} does not match its content (expected ${computed.toString()})`,
        );
      }
      index.set(block.cid.toString(), block.bytes);
    }),
  );
  const getBlock = (cid: CID): Uint8Array | undefined =>
    index.get(cid.toString());

  const commitBytes = getBlock(head);
  if (!commitBytes) {
    throw new Error("migrate: root commit block is missing from the CAR");
  }
  const commit = decodeCbor(commitBytes);
  assertSignedCommit(commit);
  if (commit.version !== COMMIT_VERSION) {
    throw new Error(
      `migrate: unsupported commit version ${commit.version} (expected ${COMMIT_VERSION})`,
    );
  }

  let signatureVerified = false;
  if (options.verifyKey) {
    signatureVerified = await verifyCommit(
      commit,
      options.verifyKey.publicKeyRaw,
      options.verifyKey.curve,
    );
    if (!signatureVerified) {
      throw new Error("migrate: root commit signature failed to verify");
    }
  }

  const entries = await walkEntries(commit.data, getBlock);
  const records: ImportedRecord[] = entries.map((entry) => {
    const slash = entry.key.indexOf("/");
    if (slash <= 0 || slash === entry.key.length - 1) {
      throw new Error(`migrate: invalid record key \`${entry.key}\``);
    }
    const collection = entry.key.slice(0, slash);
    const rkey = entry.key.slice(slash + 1);
    // The CAR is untrusted: only import syntactically valid AT Protocol paths.
    if (!isValidNsid(collection) || !isValidRecordKey(rkey)) {
      throw new Error(`migrate: invalid record path \`${entry.key}\``);
    }
    const recordBytes = getBlock(entry.value);
    if (!recordBytes) {
      throw new Error(
        `migrate: record block ${entry.value.toString()} for \`${entry.key}\` is missing from the CAR`,
      );
    }
    return {
      collection,
      rkey,
      cid: entry.value,
      bytes: recordBytes,
      value: cborToJson(decodeCbor(recordBytes)),
    };
  });

  return {
    did: commit.did,
    rev: commit.rev,
    commit,
    head,
    signatureVerified,
    records,
  };
}
