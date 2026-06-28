import { describe, expect, it } from "vitest";

import { writeCar, type CarBlock } from "./car.js";
import { encodeCbor } from "./cbor.js";
import { CID, DAG_CBOR_CODEC } from "./cid.js";
import { createRepoKeypair, loadSigner } from "./crypto.js";
import { buildMst, type MstEntry } from "./mst.js";
import { jsonToCbor, recordPath, type JsonValue } from "./record.js";
import { formatCommit } from "./repo.js";
import { TidClock } from "./tid.js";
import { importRepoFromCar } from "./migrate.js";

const tid = new TidClock();

/** Build a signed repository CAR over the given records, for import tests. */
async function buildRepoCar(
  did: string,
  curve: "p256" | "secp256k1",
  records: { collection: string; rkey: string; value: JsonValue }[],
) {
  const keypair = await createRepoKeypair(curve);
  const sign = await loadSigner(keypair.curve, keypair.privateKeyExport);

  const blocks: CarBlock[] = [];
  const entries: MstEntry[] = [];
  for (const r of records) {
    const bytes = encodeCbor(jsonToCbor(r.value));
    const cid = await CID.create(DAG_CBOR_CODEC, bytes);
    blocks.push({ cid, bytes });
    entries.push({ key: recordPath(r.collection, r.rkey), value: cid });
  }

  const mst = await buildMst(entries);
  for (const [cidStr, bytes] of mst.blocks) {
    blocks.push({ cid: CID.parse(cidStr), bytes });
  }

  const formatted = await formatCommit(
    { did, version: 3, data: mst.root, rev: tid.next(), prev: null },
    sign,
  );
  blocks.push({ cid: formatted.cid, bytes: formatted.bytes });

  return { car: writeCar([formatted.cid], blocks), keypair };
}

describe("importRepoFromCar", () => {
  it("recovers the commit and records from a signed repo CAR", async () => {
    const did = "did:plc:abc234abc234abc234abc234";
    const { car, keypair } = await buildRepoCar(did, "secp256k1", [
      {
        collection: "app.bsky.feed.post",
        rkey: "aaa",
        value: { $type: "app.bsky.feed.post", text: "first" },
      },
      {
        collection: "app.bsky.actor.profile",
        rkey: "self",
        value: { $type: "app.bsky.actor.profile", displayName: "Alice" },
      },
    ]);

    const imported = await importRepoFromCar(car, {
      verifyKey: { publicKeyRaw: keypair.publicKeyRaw, curve: keypair.curve },
    });

    expect(imported.did).toBe(did);
    expect(imported.signatureVerified).toBe(true);
    expect(imported.records).toHaveLength(2);
    const post = imported.records.find(
      (r) => r.collection === "app.bsky.feed.post",
    )!;
    expect(post.rkey).toBe("aaa");
    expect(post.value).toMatchObject({ text: "first" });
    const profile = imported.records.find(
      (r) => r.collection === "app.bsky.actor.profile",
    )!;
    expect(profile.rkey).toBe("self");
    expect(profile.value).toMatchObject({ displayName: "Alice" });
  });

  it("imports without verification when no key is supplied", async () => {
    const { car } = await buildRepoCar(
      "did:plc:noverify0000000000000000",
      "p256",
      [
        {
          collection: "app.bsky.feed.post",
          rkey: "x",
          value: { $type: "app.bsky.feed.post", text: "hi" },
        },
      ],
    );
    const imported = await importRepoFromCar(car);
    expect(imported.signatureVerified).toBe(false);
    expect(imported.records).toHaveLength(1);
  });

  it("rejects a CAR whose commit signature does not match the key", async () => {
    const { car } = await buildRepoCar(
      "did:plc:abc234abc234abc234abc234",
      "p256",
      [
        {
          collection: "app.bsky.feed.post",
          rkey: "x",
          value: { $type: "app.bsky.feed.post", text: "hi" },
        },
      ],
    );
    // A different key than the one that signed the commit.
    const wrong = await createRepoKeypair("p256");
    await expect(
      importRepoFromCar(car, {
        verifyKey: { publicKeyRaw: wrong.publicKeyRaw, curve: "p256" },
      }),
    ).rejects.toThrow(/signature failed to verify/);
  });

  it("throws on a CAR with no root commit", async () => {
    await expect(importRepoFromCar(writeCar([], []))).rejects.toThrow(
      /no root commit/,
    );
  });

  it("rejects a CAR whose root block is not a well-formed commit", async () => {
    const bytes = encodeCbor({ not: "a commit" });
    const cid = await CID.create(DAG_CBOR_CODEC, bytes);
    const car = writeCar([cid], [{ cid, bytes }]);
    await expect(importRepoFromCar(car)).rejects.toThrow(
      /malformed or missing required fields/,
    );
  });

  it("rejects a CAR containing an invalid record path (untrusted input)", async () => {
    const { car } = await buildRepoCar(
      "did:plc:abc234abc234abc234abc234",
      "p256",
      // "nodot" is not a valid NSID (no dotted segments).
      [{ collection: "nodot", rkey: "x", value: { $type: "x", text: "hi" } }],
    );
    await expect(importRepoFromCar(car)).rejects.toThrow(/invalid record path/);
  });
});
