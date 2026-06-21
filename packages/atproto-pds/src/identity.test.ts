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

  it("validates handles as domain names", () => {
    expect(isValidHandle("alice.example.com")).toBe(true);
    expect(isValidHandle("not a handle")).toBe(false);
    expect(isValidHandle("nodot")).toBe(false);
  });
});
