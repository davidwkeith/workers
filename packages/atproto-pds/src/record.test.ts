import { describe, expect, it } from "vitest";

import { encodeCbor } from "./cbor.js";
import { CID, DAG_CBOR_CODEC } from "./cid.js";
import { atUri, cborToJson, jsonToCbor, recordPath } from "./record.js";

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

  it("builds repository paths and at:// URIs", () => {
    expect(recordPath("app.bsky.feed.post", "abc")).toBe(
      "app.bsky.feed.post/abc",
    );
    expect(atUri("did:web:a", "app.bsky.feed.post", "abc")).toBe(
      "at://did:web:a/app.bsky.feed.post/abc",
    );
  });
});
