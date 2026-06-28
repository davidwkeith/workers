import { describe, expect, it } from "vitest";

import { encodeCbor } from "./cbor.js";
import { CID, DAG_CBOR_CODEC } from "./cid.js";
import {
  atUri,
  cborToJson,
  extractBlobCids,
  jsonToCbor,
  recordPath,
} from "./record.js";

describe("record JSON ⇄ DAG-CBOR", () => {
  it("round-trips a plain lexicon record", () => {
    const record = {
      $type: "app.bsky.feed.post",
      text: "hello world",
      createdAt: "2026-06-20T00:00:00.000Z",
      langs: ["en"],
      count: 3,
    };
    const cbor = jsonToCbor(record);
    expect(cborToJson(cbor)).toEqual(record);
  });

  it("maps $link to a CID and back", async () => {
    const cid = await CID.create(DAG_CBOR_CODEC, encodeCbor({ a: 1 }));
    const json = { subject: { $link: cid.toString() } };
    const cbor = jsonToCbor(json) as { subject: CID };
    expect(cbor.subject).toBeInstanceOf(CID);
    expect(cbor.subject.toString()).toBe(cid.toString());
    expect(cborToJson(cbor)).toEqual(json);
  });

  it("maps $bytes to raw bytes and back", () => {
    const json = { blob: { $bytes: "AAEC" } };
    const cbor = jsonToCbor(json) as { blob: Uint8Array };
    expect(cbor.blob).toBeInstanceOf(Uint8Array);
    expect([...cbor.blob]).toEqual([0, 1, 2]);
    expect(cborToJson(cbor)).toEqual(json);
  });

  it("stores a __proto__ key as data without polluting the prototype", () => {
    // JSON.parse creates `__proto__` as an own property (no setter), matching
    // the hostile shape an XRPC client could send as a record.
    const json = JSON.parse('{"__proto__": { "polluted": true }, "ok": 1}');
    const cbor = jsonToCbor(json);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // The result keeps the standard prototype; `__proto__` is an own data key.
    expect(Object.getPrototypeOf(cbor)).toBe(Object.prototype);
    expect(cborToJson(cbor)).toHaveProperty("ok", 1);
  });

  it("builds repository paths and at:// URIs", () => {
    expect(recordPath("app.bsky.feed.post", "abc")).toBe(
      "app.bsky.feed.post/abc",
    );
    expect(atUri("did:web:a", "app.bsky.feed.post", "abc")).toBe(
      "at://did:web:a/app.bsky.feed.post/abc",
    );
  });

  it("extracts blob ref CIDs from a record (and ignores non-blobs)", async () => {
    const blobCid = await CID.create(DAG_CBOR_CODEC, encodeCbor({ b: 1 }));
    const otherCid = await CID.create(DAG_CBOR_CODEC, encodeCbor({ o: 2 }));
    const record = jsonToCbor({
      $type: "app.bsky.actor.profile",
      displayName: "Alice",
      avatar: {
        $type: "blob",
        ref: { $link: blobCid.toString() },
        mimeType: "image/png",
        size: 1234,
      },
      // A nested blob, plus a plain CID link that is NOT a blob ref.
      pinned: { subject: { $link: otherCid.toString() } },
      banners: [
        {
          $type: "blob",
          ref: { $link: blobCid.toString() },
          mimeType: "image/png",
          size: 1,
        },
      ],
    });
    const cids = extractBlobCids(record);
    expect(cids).toContain(blobCid.toString());
    expect(cids).not.toContain(otherCid.toString());
    expect(cids).toHaveLength(2); // one in avatar, one in banners[]
  });

  it("returns no blob CIDs for a record without blobs", () => {
    expect(
      extractBlobCids(jsonToCbor({ $type: "app.bsky.feed.post", text: "hi" })),
    ).toEqual([]);
  });
});
