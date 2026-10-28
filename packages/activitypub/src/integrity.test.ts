import { beforeAll, describe, expect, it } from "vitest";

import {
  decodeMultikey,
  verifyProof,
  type JsonObject,
} from "@dwk/vc/data-integrity";

import { DATA_INTEGRITY_CONTEXT } from "./as2.js";
import {
  assertIntegrityKey,
  buildAssertionMethod,
  importIntegritySigner,
  integrityKeyId,
  signOwnActivity,
  type IntegritySigner,
} from "./integrity.js";

const ACTOR = "https://social.example/users/bob";

let jwk: JsonWebKey;
let integrity: IntegritySigner;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  integrity = await importIntegritySigner(ACTOR, jwk);
});

/** Verify `doc`'s proof against `ACTOR`'s published assertion method. */
function verifyAsActor(doc: JsonObject) {
  const method = buildAssertionMethod(ACTOR, jwk);
  return verifyProof(doc, {
    resolveVerificationMethod: (id) =>
      id === method.id
        ? {
            id,
            type: "Multikey",
            controller: method.controller as string,
            publicKeyMultibase: method.publicKeyMultibase as string,
          }
        : undefined,
    expectedController: ACTOR,
  });
}

describe("assertIntegrityKey", () => {
  it("accepts an Ed25519 private JWK", () => {
    expect(() => assertIntegrityKey(jwk)).not.toThrow();
  });

  it.each([
    [{ kty: "RSA" }, /Ed25519 JWK/],
    [{ kty: "OKP", crv: "X25519", x: "AA", d: "AA" }, /Ed25519 JWK/],
    [{ kty: "OKP", crv: "Ed25519", x: "AA" }, /missing `d`/],
    [{ kty: "OKP", crv: "Ed25519", x: "AAAA", d: "AA" }, /32-byte/],
  ])("rejects %j", (bad, message) => {
    expect(() => assertIntegrityKey(bad as JsonWebKey)).toThrow(message);
  });
});

describe("buildAssertionMethod", () => {
  it("publishes the JWK's public half as a FEP-521a Multikey", () => {
    const method = buildAssertionMethod(ACTOR, jwk);
    expect(method).toMatchObject({
      id: `${ACTOR}#ed25519-key`,
      type: "Multikey",
      controller: ACTOR,
    });
    const { rawPublicKey } = decodeMultikey(
      method.publicKeyMultibase as string,
    );
    const x = btoa(String.fromCharCode(...rawPublicKey))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(x).toBe(jwk.x);
  });
});

describe("signOwnActivity", () => {
  const now = () => Date.UTC(2026, 9, 28, 12, 0, 0);
  const create = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${ACTOR}/activities/1`,
    type: "Create",
    actor: ACTOR,
    object: {
      id: `${ACTOR}/notes/1`,
      type: "Note",
      attributedTo: ACTOR,
      content: "Hello world",
    },
  };

  it("adds an eddsa-jcs-2022 proof that verifies against the actor's Multikey", async () => {
    const signed = JSON.parse(
      await signOwnActivity(JSON.stringify(create), integrity, now),
    ) as JsonObject;

    expect(signed["@context"]).toEqual([
      "https://www.w3.org/ns/activitystreams",
      DATA_INTEGRITY_CONTEXT,
    ]);
    expect(signed.proof).toEqual({
      "@context": signed["@context"],
      type: "DataIntegrityProof",
      cryptosuite: "eddsa-jcs-2022",
      created: "2026-10-28T12:00:00Z",
      verificationMethod: integrityKeyId(ACTOR),
      proofPurpose: "assertionMethod",
      proofValue: expect.stringMatching(/^z/) as unknown as string,
    });
    expect(await verifyAsActor(signed)).toEqual({
      verified: true,
      errors: [],
    });
  });

  it("produces a proof that fails once the activity is tampered with", async () => {
    const signed = JSON.parse(
      await signOwnActivity(JSON.stringify(create), integrity, now),
    ) as JsonObject & { object: { content: string } };
    signed.object.content = "Goodbye world";
    expect((await verifyAsActor(signed)).verified).toBe(false);
  });

  it("accepts an embedded actor object", async () => {
    const signed = JSON.parse(
      await signOwnActivity(
        JSON.stringify({ ...create, actor: { id: ACTOR, type: "Person" } }),
        integrity,
        now,
      ),
    ) as JsonObject;
    expect(signed.proof).toBeDefined();
  });

  it.each([
    [
      "another actor's activity",
      { ...create, actor: "https://remote.example/users/alice" },
    ],
    [
      "an already-proofed activity",
      { ...create, proof: { type: "DataIntegrityProof" } },
    ],
    ["a fragment-identified activity", { ...create, id: `${ACTOR}#accepts/1` }],
  ])("leaves %s unchanged", async (_label, activity) => {
    const json = JSON.stringify(activity);
    expect(await signOwnActivity(json, integrity, now)).toBe(json);
  });

  it("leaves unparseable JSON unchanged", async () => {
    expect(await signOwnActivity("{nope", integrity, now)).toBe("{nope");
  });
});
