import { describe, expect, it } from "vitest";

import { buildDidDocument, didWebFromHost, isValidHandle } from "./identity.js";

describe("identity", () => {
  it("derives did:web from a hostname", () => {
    expect(didWebFromHost("alice.example.com")).toBe(
      "did:web:alice.example.com",
    );
  });

  it("percent-encodes a host:port for did:web", () => {
    expect(didWebFromHost("localhost:8787")).toBe("did:web:localhost%3A8787");
  });

  it("builds a DID document advertising the key and PDS service", () => {
    const doc = buildDidDocument({
      did: "did:web:alice.example.com",
      handle: "alice.example.com",
      pdsEndpoint: "https://alice.example.com",
      publicKeyMultibase: "zDnTEST",
      curve: "p256",
    }) as Record<string, unknown>;
    expect(doc.id).toBe("did:web:alice.example.com");
    expect(doc.alsoKnownAs).toEqual(["at://alice.example.com"]);
    const vm = (doc.verificationMethod as Record<string, unknown>[])[0]!;
    expect(vm.type).toBe("Multikey");
    expect(vm.publicKeyMultibase).toBe("zDnTEST");
    const service = (doc.service as Record<string, unknown>[])[0]!;
    expect(service.type).toBe("AtprotoPersonalDataServer");
    expect(service.serviceEndpoint).toBe("https://alice.example.com");
  });

  it("advertises the secp256k1 suite context only for a secp256k1 key", () => {
    const base = {
      did: "did:web:alice.example.com",
      handle: "alice.example.com",
      pdsEndpoint: "https://alice.example.com",
      publicKeyMultibase: "zDnTEST",
    };
    const secpSuite = "https://w3id.org/security/suites/secp256k1-2019/v1";
    const p256 = buildDidDocument({ ...base, curve: "p256" }) as Record<
      string,
      unknown
    >;
    const secp = buildDidDocument({ ...base, curve: "secp256k1" }) as Record<
      string,
      unknown
    >;
    // Both carry the Multikey context; only secp256k1 carries the legacy suite.
    expect(p256["@context"]).toContain("https://w3id.org/security/multikey/v1");
    expect(p256["@context"]).not.toContain(secpSuite);
    expect(secp["@context"]).toContain(secpSuite);
  });

  it("validates handles as domain names", () => {
    expect(isValidHandle("alice.example.com")).toBe(true);
    expect(isValidHandle("not a handle")).toBe(false);
    expect(isValidHandle("nodot")).toBe(false);
  });
});
