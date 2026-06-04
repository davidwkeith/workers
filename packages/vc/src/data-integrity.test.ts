import { describe, expect, it } from "vitest";

import {
  addProof,
  importSigner,
  verifyProof,
  type JsonObject,
  type VerificationMethod,
} from "./data-integrity";
import { encodeEd25519Multikey } from "./multibase";
import type { JcsValue } from "./jcs";

const VM_ID = "did:web:example.com#key-0";

async function ed25519Material(): Promise<{
  privateJwk: JsonWebKey;
  multikeyVm: VerificationMethod;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  )) as JsonWebKey;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  return {
    privateJwk,
    multikeyVm: {
      id: VM_ID,
      type: "Multikey",
      publicKeyMultibase: encodeEd25519Multikey(raw),
    },
  };
}

async function ecMaterial(curve: "P-256" | "P-384"): Promise<{
  privateJwk: JsonWebKey;
  jwkVm: VerificationMethod;
}> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: curve },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  )) as JsonWebKey;
  const publicKeyJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;
  return { privateJwk, jwkVm: { id: VM_ID, type: "JsonWebKey", publicKeyJwk } };
}

const sampleDoc = (): JsonObject => ({
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  type: ["VerifiableCredential"],
  issuer: "did:web:example.com",
  validFrom: "2026-06-04T00:00:00Z",
  credentialSubject: { id: "did:web:alice.example", name: "Alice" },
});

describe("eddsa-jcs-2022", () => {
  it("attaches a base58-btc multibase proof and verifies it", async () => {
    const { privateJwk, multikeyVm } = await ed25519Material();
    const signer = await importSigner(privateJwk);
    expect(signer.cryptosuite).toBe("eddsa-jcs-2022");

    const secured = await addProof(sampleDoc(), signer, {
      verificationMethod: VM_ID,
    });
    expect(secured.proof.type).toBe("DataIntegrityProof");
    expect(secured.proof.cryptosuite).toBe("eddsa-jcs-2022");
    expect(typeof secured.proof.proofValue).toBe("string");
    expect((secured.proof.proofValue as string)[0]).toBe("z");

    const result = await verifyProof(secured, {
      resolveVerificationMethod: () => multikeyVm,
    });
    expect(result).toEqual({ verified: true, errors: [] });
  });

  it("fails when the document is tampered with", async () => {
    const { privateJwk, multikeyVm } = await ed25519Material();
    const signer = await importSigner(privateJwk);
    const secured = await addProof(sampleDoc(), signer, {
      verificationMethod: VM_ID,
    });
    (secured.credentialSubject as JsonObject).name = "Mallory";

    const result = await verifyProof(secured, {
      resolveVerificationMethod: () => multikeyVm,
    });
    expect(result.verified).toBe(false);
    expect(result.errors).toContain("signature verification failed");
  });

  it("rejects a mismatched proof purpose", async () => {
    const { privateJwk, multikeyVm } = await ed25519Material();
    const signer = await importSigner(privateJwk);
    const secured = await addProof(sampleDoc(), signer, {
      verificationMethod: VM_ID,
      proofPurpose: "authentication",
    });
    const result = await verifyProof(secured, {
      resolveVerificationMethod: () => multikeyVm,
      expectedProofPurpose: "assertionMethod",
    });
    expect(result.verified).toBe(false);
    expect(result.errors[0]).toMatch(/proof purpose/);
  });

  it("reports an unresolvable verification method", async () => {
    const { privateJwk } = await ed25519Material();
    const signer = await importSigner(privateJwk);
    const secured = await addProof(sampleDoc(), signer, {
      verificationMethod: VM_ID,
    });
    const result = await verifyProof(secured, {
      resolveVerificationMethod: () => undefined,
    });
    expect(result.verified).toBe(false);
    expect(result.errors[0]).toMatch(/could not resolve/);
  });

  it("verifies via a publicKeyJwk verification method too", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const privateJwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.privateKey,
    )) as JsonWebKey;
    const publicKeyJwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.publicKey,
    )) as JsonWebKey;
    const signer = await importSigner(privateJwk);
    const secured = await addProof(sampleDoc(), signer, {
      verificationMethod: VM_ID,
    });
    const result = await verifyProof(secured, {
      resolveVerificationMethod: () => ({
        id: VM_ID,
        type: "JsonWebKey",
        publicKeyJwk,
      }),
    });
    expect(result.verified).toBe(true);
  });
});

describe("ecdsa-jcs-2019", () => {
  for (const curve of ["P-256", "P-384"] as const) {
    it(`signs and verifies with ${curve}`, async () => {
      const { privateJwk, jwkVm } = await ecMaterial(curve);
      const signer = await importSigner(privateJwk);
      expect(signer.cryptosuite).toBe("ecdsa-jcs-2019");

      const secured = await addProof(sampleDoc(), signer, {
        verificationMethod: VM_ID,
      });
      const result = await verifyProof(secured, {
        resolveVerificationMethod: () => jwkVm,
      });
      expect(result.verified).toBe(true);
    });
  }

  it("rejects a Multikey verification method for an EC proof", async () => {
    const { privateJwk } = await ecMaterial("P-256");
    const { multikeyVm } = await ed25519Material();
    const signer = await importSigner(privateJwk);
    const secured = await addProof(sampleDoc(), signer, {
      verificationMethod: VM_ID,
    });
    const result = await verifyProof(secured, {
      resolveVerificationMethod: () => multikeyVm,
    });
    expect(result.verified).toBe(false);
    expect(result.errors[0]).toMatch(/Multikey.*eddsa-jcs-2022/);
  });
});

describe("verifyProof", () => {
  it("fails a document with no proof", async () => {
    const result = await verifyProof(sampleDoc(), {
      resolveVerificationMethod: () => undefined,
    });
    expect(result).toEqual({
      verified: false,
      errors: ["document has no proof"],
    });
  });

  it("treats a null or non-object proof as no proof (no crash)", async () => {
    const proofs: JcsValue[] = [null as unknown as JcsValue, "nope", [null]];
    for (const proof of proofs) {
      const result = await verifyProof(
        { ...sampleDoc(), proof },
        { resolveVerificationMethod: () => undefined },
      );
      expect(result).toEqual({
        verified: false,
        errors: ["document has no proof"],
      });
    }
  });
});

describe("importSigner", () => {
  it("rejects a public-only JWK", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicJwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.publicKey,
    )) as JsonWebKey;
    await expect(importSigner(publicJwk)).rejects.toThrow(/private `d`/);
  });
});
