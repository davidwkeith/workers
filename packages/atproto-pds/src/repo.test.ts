import { describe, expect, it } from "vitest";

import { encodeCbor } from "./cbor.js";
import { CID, DAG_CBOR_CODEC } from "./cid.js";
import { exportPublicKeyRaw, generateSigningKey, signData } from "./crypto.js";
import { formatCommit, verifyCommit } from "./repo.js";

describe("repository commits", () => {
  it("signs a commit whose signature verifies against the repo key", async () => {
    const pair = await generateSigningKey();
    const raw = await exportPublicKeyRaw(pair.publicKey);
    const data = await CID.create(DAG_CBOR_CODEC, encodeCbor({ mst: "root" }));

    const formatted = await formatCommit(
      {
        did: "did:web:alice.example",
        version: 3,
        data,
        rev: "3aaaaaaaaaaaa",
        prev: null,
      },
      (bytes) => signData(pair.privateKey, bytes),
    );

    expect(formatted.cid.codec).toBe(DAG_CBOR_CODEC);
    expect(formatted.commit.sig.length).toBe(64);
    expect(await verifyCommit(formatted.commit, raw)).toBe(true);
  });

  it("rejects a commit signed by a different key", async () => {
    const signer = await generateSigningKey();
    const other = await generateSigningKey();
    const otherRaw = await exportPublicKeyRaw(other.publicKey);
    const data = await CID.create(DAG_CBOR_CODEC, encodeCbor({ mst: "root" }));

    const formatted = await formatCommit(
      {
        did: "did:web:alice.example",
        version: 3,
        data,
        rev: "3aaaaaaaaaaaa",
        prev: null,
      },
      (bytes) => signData(signer.privateKey, bytes),
    );
    expect(await verifyCommit(formatted.commit, otherRaw)).toBe(false);
  });

  it("chains commits through prev", async () => {
    const pair = await generateSigningKey();
    const data = await CID.create(DAG_CBOR_CODEC, encodeCbor({ mst: 1 }));
    const first = await formatCommit(
      { did: "did:web:a", version: 3, data, rev: "3aaaaaaaaaaaa", prev: null },
      (bytes) => signData(pair.privateKey, bytes),
    );
    const second = await formatCommit(
      {
        did: "did:web:a",
        version: 3,
        data,
        rev: "3bbbbbbbbbbbb",
        prev: first.cid,
      },
      (bytes) => signData(pair.privateKey, bytes),
    );
    expect(second.commit.prev?.equals(first.cid)).toBe(true);
    expect(second.cid.equals(first.cid)).toBe(false);
  });
});
