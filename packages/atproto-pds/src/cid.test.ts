import { describe, expect, it } from "vitest";

import { encodeCbor } from "./cbor";
import { CID, DAG_CBOR_CODEC, RAW_CODEC } from "./cid";

describe("CID", () => {
  it("creates a base32 CIDv1 string with the multibase prefix", async () => {
    const cid = await CID.create(DAG_CBOR_CODEC, encodeCbor({ a: 1 }));
    expect(cid.toString().startsWith("b")).toBe(true);
    expect(cid.codec).toBe(DAG_CBOR_CODEC);
  });

  it("round-trips through parse/toString", async () => {
    const cid = await CID.create(DAG_CBOR_CODEC, new Uint8Array([1, 2, 3]));
    const parsed = CID.parse(cid.toString());
    expect(parsed.equals(cid)).toBe(true);
    expect(parsed.codec).toBe(DAG_CBOR_CODEC);
  });

  it("round-trips raw-codec CIDs (blobs)", async () => {
    const cid = await CID.create(RAW_CODEC, new Uint8Array([9, 9, 9]));
    expect(CID.decode(cid.bytes).equals(cid)).toBe(true);
    expect(cid.codec).toBe(RAW_CODEC);
  });

  it("is content-addressed: identical bytes yield identical CIDs", async () => {
    const a = await CID.create(DAG_CBOR_CODEC, new Uint8Array([1, 2]));
    const b = await CID.create(DAG_CBOR_CODEC, new Uint8Array([1, 2]));
    expect(a.equals(b)).toBe(true);
  });

  it("decodeFirst reports where the CID ends", async () => {
    const cid = await CID.create(DAG_CBOR_CODEC, new Uint8Array([7]));
    const buf = new Uint8Array(cid.bytes.length + 3);
    buf.set(cid.bytes, 0);
    buf.set([0xaa, 0xbb, 0xcc], cid.bytes.length);
    const { cid: decoded, end } = CID.decodeFirst(buf, 0);
    expect(decoded.equals(cid)).toBe(true);
    expect(end).toBe(cid.bytes.length);
  });
});
