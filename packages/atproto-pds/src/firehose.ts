/**
 * The AT Protocol repository firehose frame format
 * (`com.atproto.sync.subscribeRepos`).
 *
 * Each event on the stream is a binary message: two concatenated **DAG-CBOR**
 * objects — a header `{ op: 1, t: "#commit" }` (or `t: "#sync"`, `"#identity"`,
 * `"#account"`; `op: -1` for an error) followed by the message body. This module
 * is the pure, Workers-runtime-free encoder for those frames; the Durable Object
 * (which owns the sequence cursor and the hibernatable sockets) assembles a
 * {@link FirehoseCommit} per repo commit and broadcasts the encoded frame.
 *
 * Relays subscribe to this stream to crawl the repository in real time — without
 * it, records written here are not discoverable by the network.
 */

import { concatBytes } from "./bytes.js";
import { encodeCbor, type CborValue } from "./cbor.js";
import type { CID } from "./cid.js";

/** A single repository mutation in a `#commit` event. */
export interface FirehoseRepoOp {
  readonly action: "create" | "update" | "delete";
  /** The record path (`collection/rkey`). */
  readonly path: string;
  /** The new record CID (create/update), or `null` for a delete. */
  readonly cid: CID | null;
  /** The previous record CID, for updates and deletes (optional). */
  readonly prev?: CID | null;
}

/** A `#commit` event: a repository commit ready to be framed onto the stream. */
export interface FirehoseCommit {
  /** Monotonic stream sequence number. */
  readonly seq: number;
  /** The repo DID this event comes from. */
  readonly repo: string;
  /** The signed commit's CID. */
  readonly commit: CID;
  /** This commit's revision. */
  readonly rev: string;
  /** The previous emitted commit's revision, or `null`. */
  readonly since: string | null;
  /** CAR of the blocks needed to apply this commit (a diff since `since`). */
  readonly blocks: Uint8Array;
  /** The mutations in this commit. */
  readonly ops: readonly FirehoseRepoOp[];
  /**
   * Whether the commit's diff was too large to inline. When true, `blocks` is an
   * empty CAR and `ops`/`blobs` are empty — a consumer falls back to `getRepo`.
   */
  readonly tooBig: boolean;
  /** CIDs of blobs newly referenced by this commit's created/updated records. */
  readonly blobs: readonly CID[];
  /** ISO timestamp this event was broadcast. */
  readonly time: string;
  /** Root CID of the previous commit's MST tree (optional). */
  readonly prevData?: CID | null;
}

/**
 * An `#account` event: the account's hosting status on this PDS changed (e.g.
 * the activate/deactivate cutover of a migration). Relays consume it to update
 * which PDS is the live home without re-polling `getRepoStatus`.
 */
export interface FirehoseAccount {
  /** Monotonic stream sequence number (shared with `#commit`). */
  readonly seq: number;
  /** The repo DID whose status changed. */
  readonly did: string;
  /** ISO timestamp this event was broadcast. */
  readonly time: string;
  /** Whether the account is active (hosted and serving) here. */
  readonly active: boolean;
  /**
   * The inactive reason when `active` is false — a lexicon known value such as
   * `"deactivated"`, `"suspended"`, `"takendown"`, or `"deleted"`. Omitted when
   * `active` is true.
   */
  readonly status?: string;
}

/**
 * An `#identity` event: the account's identity changed (here, a handle update).
 * Relays consume it to re-resolve the handle ⇄ DID binding.
 */
export interface FirehoseIdentity {
  /** Monotonic stream sequence number (shared with `#commit`). */
  readonly seq: number;
  /** The repo DID whose identity changed. */
  readonly did: string;
  /** ISO timestamp this event was broadcast. */
  readonly time: string;
  /** The account's new handle, when known. */
  readonly handle?: string;
}

/** Encode an event-stream frame **header** (`{ op: 1, t }`) as DAG-CBOR. */
export function encodeFrameHeader(t: string): Uint8Array {
  return encodeCbor({ op: 1, t });
}

/** The DAG-CBOR body of a `#commit` message (without the frame header). */
export function encodeCommitBody(commit: FirehoseCommit): Uint8Array {
  const body: { [key: string]: CborValue } = {
    seq: commit.seq,
    // `rebase` is deprecated-but-required by the lexicon; always false here.
    rebase: false,
    tooBig: commit.tooBig,
    repo: commit.repo,
    commit: commit.commit,
    rev: commit.rev,
    since: commit.since,
    blocks: commit.blocks,
    ops: commit.ops.map((op) => {
      const out: { [key: string]: CborValue } = {
        action: op.action,
        path: op.path,
        cid: op.cid,
      };
      if (op.prev !== undefined) out.prev = op.prev;
      return out;
    }),
    blobs: [...commit.blobs],
    time: commit.time,
  };
  if (commit.prevData !== undefined && commit.prevData !== null) {
    body.prevData = commit.prevData;
  }
  return encodeCbor(body);
}

/** Encode a full `#commit` frame: the header followed by the body. */
export function encodeCommitFrame(commit: FirehoseCommit): Uint8Array {
  return concatBytes([encodeFrameHeader("#commit"), encodeCommitBody(commit)]);
}

/**
 * Encode an `#account` frame: the header (`{ op: 1, t: "#account" }`) followed
 * by `{ seq, did, time, active, status? }`. The `status` field is present only
 * for an inactive account.
 */
export function encodeAccountFrame(account: FirehoseAccount): Uint8Array {
  const body: { [key: string]: CborValue } = {
    seq: account.seq,
    did: account.did,
    time: account.time,
    active: account.active,
  };
  // The lexicon permits `status` only for an inactive account; never emit it for
  // an active one, regardless of what the caller passed.
  if (!account.active && account.status !== undefined) {
    body.status = account.status;
  }
  return concatBytes([encodeFrameHeader("#account"), encodeCbor(body)]);
}

/**
 * Encode an `#identity` frame: the header (`{ op: 1, t: "#identity" }`) followed
 * by `{ seq, did, time, handle? }`. Emitted when the account's handle changes.
 */
export function encodeIdentityFrame(identity: FirehoseIdentity): Uint8Array {
  const body: { [key: string]: CborValue } = {
    seq: identity.seq,
    did: identity.did,
    time: identity.time,
  };
  if (identity.handle !== undefined) body.handle = identity.handle;
  return concatBytes([encodeFrameHeader("#identity"), encodeCbor(body)]);
}

/**
 * Encode an **info** frame (`{ op: 1, t: "#info" }` + `{ name, message }`). The
 * stream uses these for non-fatal notices — e.g. `OutdatedCursor` when a
 * consumer's requested `cursor` predates the buffered backfill window.
 */
export function encodeInfoFrame(name: string, message?: string): Uint8Array {
  const body: { [key: string]: CborValue } = { name };
  if (message !== undefined) body.message = message;
  return concatBytes([encodeFrameHeader("#info"), encodeCbor(body)]);
}

/**
 * Encode an **error** frame (`{ op: -1 }` + `{ error, message }`). The header's
 * `op` is `-1` (not `1`) and carries no `t`; the body names the error — e.g.
 * `FutureCursor` for a `cursor` ahead of the stream. A consumer treats this as
 * terminal.
 */
export function encodeErrorFrame(error: string, message?: string): Uint8Array {
  const body: { [key: string]: CborValue } = { error };
  if (message !== undefined) body.message = message;
  return concatBytes([encodeCbor({ op: -1 }), encodeCbor(body)]);
}
