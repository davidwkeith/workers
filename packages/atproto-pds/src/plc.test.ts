import { describe, expect, it } from "vitest";

import {
  createRepoKeypair,
  didKeyFromPublicKey,
  loadSigner,
} from "./crypto.js";
import {
  didPlcFromGenesis,
  plcOperationCid,
  signPlcOperation,
  unsignedPlcBytes,
  verifyPlcOperation,
  type UnsignedPlcOperation,
} from "./plc.js";

/** A genesis operation wired to a freshly generated rotation + signing key. */
async function genesis(handle = "alice.example.com") {
  const rotation = await createRepoKeypair("secp256k1");
  const signing = await createRepoKeypair("p256");
  const sign = await loadSigner("secp256k1", rotation.privateKeyExport);
  const op: UnsignedPlcOperation = {
    type: "plc_operation",
    rotationKeys: [didKeyFromPublicKey(rotation.publicKeyRaw, "secp256k1")],
    verificationMethods: {
      atproto: didKeyFromPublicKey(signing.publicKeyRaw, "p256"),
    },
    alsoKnownAs: [`at://${handle}`],
    services: {
      atproto_pds: {
        type: "AtprotoPersonalDataServer",
        endpoint: `https://${handle}`,
      },
    },
    prev: null,
  };
  return { op, rotation, sign };
}

describe("did:plc operations", () => {
  it("signs a genesis operation whose signature verifies under the rotation key", async () => {
    const { op, rotation, sign } = await genesis();
    const signed = await signPlcOperation(op, sign);
    expect(signed.sig).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, unpadded
    expect(
      await verifyPlcOperation(signed, rotation.publicKeyRaw, "secp256k1"),
    ).toBe(true);
  });

  it("derives a well-formed did:plc identifier", async () => {
    const { op, sign } = await genesis();
    const signed = await signPlcOperation(op, sign);
    const did = await didPlcFromGenesis(signed);
    expect(did).toMatch(/^did:plc:[a-z2-7]{24}$/); // base32 lower, 24 chars
  });

  it("derives the DID deterministically from the signed genesis op", async () => {
    const { op, sign } = await genesis();
    const signed = await signPlcOperation(op, sign);
    expect(await didPlcFromGenesis(signed)).toBe(
      await didPlcFromGenesis(signed),
    );
  });

  it("gives different accounts different DIDs", async () => {
    const a = await genesis("alice.example.com");
    const b = await genesis("bob.example.com");
    const didA = await didPlcFromGenesis(await signPlcOperation(a.op, a.sign));
    const didB = await didPlcFromGenesis(await signPlcOperation(b.op, b.sign));
    expect(didA).not.toBe(didB);
  });

  it("rejects a tampered operation (signature is over the unsigned fields)", async () => {
    const { op, rotation, sign } = await genesis();
    const signed = await signPlcOperation(op, sign);
    const tampered = {
      ...signed,
      alsoKnownAs: ["at://attacker.example.com"],
    };
    expect(
      await verifyPlcOperation(tampered, rotation.publicKeyRaw, "secp256k1"),
    ).toBe(false);
  });

  it("supports P-256 rotation keys", async () => {
    const rotation = await createRepoKeypair("p256");
    const sign = await loadSigner("p256", rotation.privateKeyExport);
    const op: UnsignedPlcOperation = {
      type: "plc_operation",
      rotationKeys: [didKeyFromPublicKey(rotation.publicKeyRaw, "p256")],
      verificationMethods: {
        atproto: didKeyFromPublicKey(rotation.publicKeyRaw, "p256"),
      },
      alsoKnownAs: ["at://p256.example.com"],
      services: {
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: "https://p256.example.com",
        },
      },
      prev: null,
    };
    const signed = await signPlcOperation(op, sign);
    expect(
      await verifyPlcOperation(signed, rotation.publicKeyRaw, "p256"),
    ).toBe(true);
  });

  it("refuses to derive a DID from a non-genesis operation", async () => {
    const { op, sign } = await genesis();
    const rotationOp = { ...op, prev: "bafytestcid" };
    const signed = await signPlcOperation(rotationOp, sign);
    await expect(didPlcFromGenesis(signed)).rejects.toThrow(/genesis/);
  });

  it("returns false (not throws) for a malformed signature", async () => {
    const { op, rotation, sign } = await genesis();
    const signed = await signPlcOperation(op, sign);
    const bad = { ...signed, sig: "not valid base64url!!" };
    expect(
      await verifyPlcOperation(bad, rotation.publicKeyRaw, "secp256k1"),
    ).toBe(false);
  });

  it("chains a rotation operation to the genesis op via its CID", async () => {
    const { op, rotation, sign } = await genesis();
    const signedGenesis = await signPlcOperation(op, sign);
    const prev = await plcOperationCid(signedGenesis);
    expect(prev).toMatch(/^b[a-z2-7]+$/); // CIDv1 base32 string

    const rotationOp: UnsignedPlcOperation = { ...op, prev };
    const signedRotation = await signPlcOperation(rotationOp, sign);
    expect(
      await verifyPlcOperation(
        signedRotation,
        rotation.publicKeyRaw,
        "secp256k1",
      ),
    ).toBe(true);
    // The chained op signs different bytes than genesis (prev changed).
    expect(unsignedPlcBytes(rotationOp)).not.toEqual(unsignedPlcBytes(op));
  });
});
