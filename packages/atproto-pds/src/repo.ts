/**
 * Repository commits: the signed root of an AT Protocol repository.
 *
 * A commit is a small DAG-CBOR record — `{ did, version: 3, data, rev, prev }` —
 * whose `data` field is the {@link buildMst MST root} over all of the account's
 * records. It is signed over its unsigned encoding with the account's repository
 * key; the signature is attached as `sig` and the *signed* commit is itself
 * hashed to produce the repository head CID. Each new commit chains to the prior
 * one through `prev`, so the head is a verifiable, portable summary of the entire
 * repository — the thing that moves, intact, when an account changes hosts.
 */

import { encodeCbor } from "./cbor.js";
import { CID, DAG_CBOR_CODEC } from "./cid.js";
import { verifyData } from "./crypto.js";

/** The current AT Protocol repository commit version. */
export const COMMIT_VERSION = 3;

/** An unsigned commit, in the exact field set that is signed. */
export interface UnsignedCommit {
  readonly did: string;
  readonly version: number;
  readonly data: CID;
  readonly rev: string;
  readonly prev: CID | null;
}

/** A signed commit: the unsigned fields plus the 64-byte `sig`. */
export interface SignedCommit extends UnsignedCommit {
  readonly sig: Uint8Array;
}

/** The canonical bytes that are signed for a commit (the unsigned fields). */
export function unsignedCommitBytes(commit: UnsignedCommit): Uint8Array {
  return encodeCbor({
    did: commit.did,
    version: commit.version,
    data: commit.data,
    rev: commit.rev,
    prev: commit.prev,
  });
}

/** A signed, encoded commit and its head CID. */
export interface FormattedCommit {
  readonly commit: SignedCommit;
  readonly bytes: Uint8Array;
  readonly cid: CID;
}

/**
 * Sign an unsigned commit and produce its block bytes + head CID. `sign` is the
 * repository-key signer (held inside the owning Durable Object so the key never
 * leaves Cloudflare's network).
 */
export async function formatCommit(
  unsigned: UnsignedCommit,
  sign: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<FormattedCommit> {
  const sig = await sign(unsignedCommitBytes(unsigned));
  const commit: SignedCommit = { ...unsigned, sig };
  const bytes = encodeCbor({
    did: commit.did,
    version: commit.version,
    data: commit.data,
    rev: commit.rev,
    prev: commit.prev,
    sig: commit.sig,
  });
  const cid = await CID.create(DAG_CBOR_CODEC, bytes);
  return { commit, bytes, cid };
}

/** Verify a signed commit against the repository's raw public key. */
export async function verifyCommit(
  commit: SignedCommit,
  publicKeyRaw: Uint8Array,
): Promise<boolean> {
  return verifyData(publicKeyRaw, unsignedCommitBytes(commit), commit.sig);
}
