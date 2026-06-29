import { describe, expect, it } from "vitest";

import { decodeCbor, encodeCbor } from "./cbor.js";
import { CID, DAG_CBOR_CODEC } from "./cid.js";
import {
  encodeAccountFrame,
  encodeCommitBody,
  encodeCommitFrame,
  encodeErrorFrame,
  encodeFrameHeader,
  encodeInfoFrame,
  type FirehoseCommit,
} from "./firehose.js";

async function cidOf(value: unknown): Promise<CID> {
  return CID.create(DAG_CBOR_CODEC, encodeCbor(value as never));
}

describe("firehose framing", () => {
  it("encodes a #commit header", () => {
    expect(decodeCbor(encodeFrameHeader("#commit"))).toEqual({
      op: 1,
      t: "#commit",
    });
  });

  it("encodes a #commit body with all required fields", async () => {
    const commitCid = await cidOf({ commit: 1 });
    const recordCid = await cidOf({ record: 1 });
    const event: FirehoseCommit = {
      seq: 7,
      repo: "did:plc:abc234abc234abc234abc234",
      commit: commitCid,
      rev: "3labc",
      since: "3laaa",
      blocks: new Uint8Array([1, 2, 3]),
      ops: [
        { action: "create", path: "app.bsky.feed.post/x", cid: recordCid },
        { action: "delete", path: "app.bsky.feed.post/y", cid: null },
      ],
      time: "2026-06-28T00:00:00.000Z",
    };

    const body = decodeCbor(encodeCommitBody(event)) as {
      seq: number;
      rebase: boolean;
      tooBig: boolean;
      repo: string;
      commit: CID;
      rev: string;
      since: string | null;
      blocks: Uint8Array;
      ops: { action: string; path: string; cid: CID | null }[];
      blobs: unknown[];
      time: string;
    };

    expect(body.seq).toBe(7);
    expect(body.rebase).toBe(false);
    expect(body.tooBig).toBe(false);
    expect(body.repo).toBe(event.repo);
    expect(body.commit).toBeInstanceOf(CID);
    expect((body.commit as CID).toString()).toBe(commitCid.toString());
    expect(body.rev).toBe("3labc");
    expect(body.since).toBe("3laaa");
    expect([...body.blocks]).toEqual([1, 2, 3]);
    expect(body.blobs).toEqual([]);
    expect(body.time).toBe(event.time);
    expect(body.ops).toHaveLength(2);
    expect(body.ops[0]).toMatchObject({
      action: "create",
      path: "app.bsky.feed.post/x",
    });
    expect((body.ops[0]!.cid as CID).toString()).toBe(recordCid.toString());
    expect(body.ops[1]).toMatchObject({
      action: "delete",
      path: "app.bsky.feed.post/y",
      cid: null,
    });
  });

  it("frames a #commit as header followed by body", async () => {
    const event: FirehoseCommit = {
      seq: 1,
      repo: "did:web:alice.example",
      commit: await cidOf({ c: 1 }),
      rev: "3l",
      since: null,
      blocks: new Uint8Array(0),
      ops: [],
      time: "2026-06-28T00:00:00.000Z",
    };
    const header = encodeFrameHeader("#commit");
    const frame = encodeCommitFrame(event);
    // The frame is the header bytes immediately followed by the body bytes.
    expect([...frame.slice(0, header.length)]).toEqual([...header]);
    expect(decodeCbor(frame.slice(0, header.length))).toEqual({
      op: 1,
      t: "#commit",
    });
    const body = decodeCbor(frame.slice(header.length)) as { seq: number };
    expect(body.seq).toBe(1);
  });

  it("frames an #info notice (op 1) with a name and message", () => {
    const header = encodeFrameHeader("#info");
    const frame = encodeInfoFrame("OutdatedCursor", "too far back");
    expect(decodeCbor(frame.slice(0, header.length))).toEqual({
      op: 1,
      t: "#info",
    });
    expect(decodeCbor(frame.slice(header.length))).toEqual({
      name: "OutdatedCursor",
      message: "too far back",
    });
  });

  it("frames an error (op -1) with an error name, no `t`", () => {
    const errorHeader = encodeCbor({ op: -1 });
    const frame = encodeErrorFrame("FutureCursor", "ahead of the stream");
    expect(decodeCbor(frame.slice(0, errorHeader.length))).toEqual({ op: -1 });
    expect(decodeCbor(frame.slice(errorHeader.length))).toEqual({
      error: "FutureCursor",
      message: "ahead of the stream",
    });
  });

  it("omits the optional message when none is given", () => {
    const header = encodeFrameHeader("#info");
    const frame = encodeInfoFrame("OutdatedCursor");
    expect(decodeCbor(frame.slice(header.length))).toEqual({
      name: "OutdatedCursor",
    });
  });

  it("frames a deactivated #account event with a status", () => {
    const header = encodeFrameHeader("#account");
    const frame = encodeAccountFrame({
      seq: 7,
      did: "did:web:alice.example.com",
      time: "2026-06-29T00:00:00.000Z",
      active: false,
      status: "deactivated",
    });
    expect(decodeCbor(frame.slice(0, header.length))).toEqual({
      op: 1,
      t: "#account",
    });
    expect(decodeCbor(frame.slice(header.length))).toEqual({
      seq: 7,
      did: "did:web:alice.example.com",
      time: "2026-06-29T00:00:00.000Z",
      active: false,
      status: "deactivated",
    });
  });

  it("drops `status` for an active #account event even if one is passed", () => {
    const header = encodeFrameHeader("#account");
    const frame = encodeAccountFrame({
      seq: 8,
      did: "did:web:alice.example.com",
      time: "2026-06-29T00:00:01.000Z",
      active: true,
      // The lexicon forbids `status` on an active account; the encoder must drop
      // it rather than emit a malformed frame.
      status: "deactivated",
    });
    expect(decodeCbor(frame.slice(header.length))).toEqual({
      seq: 8,
      did: "did:web:alice.example.com",
      time: "2026-06-29T00:00:01.000Z",
      active: true,
    });
  });
});
