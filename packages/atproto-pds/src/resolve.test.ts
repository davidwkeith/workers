import { SsrfError } from "@dwk/safe-fetch";
import { describe, expect, it } from "vitest";

import { createRepoKeypair, publicKeyMultibase } from "./crypto.js";
import type { FetchLike } from "./plc-directory.js";
import { resolveDidDocument, resolveSigningKey } from "./resolve.js";

/** A DID document advertising `multibase` as the `#atproto` signing key. */
function didDoc(did: string, multibase: string) {
  return {
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: "Multikey",
        controller: did,
        publicKeyMultibase: multibase,
      },
    ],
  };
}

describe("resolveSigningKey", () => {
  it("resolves a did:web key from the origin's did.json", async () => {
    const kp = await createRepoKeypair("p256");
    const did = "did:web:alice.example.com";
    const multibase = publicKeyMultibase(kp.publicKeyRaw, "p256");
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(didDoc(did, multibase)), {
        status: 200,
      });
    };

    const key = await resolveSigningKey(did, { fetchImpl });
    expect(calls[0]).toBe("https://alice.example.com/.well-known/did.json");
    expect(key.curve).toBe("p256");
    expect(key.publicKeyRaw).toEqual(kp.publicKeyRaw);
  });

  it("resolves a path-based did:web from /<path>/did.json", async () => {
    const kp = await createRepoKeypair("p256");
    const did = "did:web:example.com:users:alice";
    const multibase = publicKeyMultibase(kp.publicKeyRaw, "p256");
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(didDoc(did, multibase)), {
        status: 200,
      });
    };

    const key = await resolveSigningKey(did, { fetchImpl });
    expect(calls[0]).toBe("https://example.com/users/alice/did.json");
    expect(key.publicKeyRaw).toEqual(kp.publicKeyRaw);
  });

  it("resolves a did:plc key from the directory", async () => {
    const kp = await createRepoKeypair("secp256k1");
    const did = "did:plc:abc234abc234abc234abc234";
    const multibase = publicKeyMultibase(kp.publicKeyRaw, "secp256k1");
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(didDoc(did, multibase)), {
        status: 200,
      });
    };

    const key = await resolveSigningKey(did, {
      plcDirectoryUrl: "https://plc.test",
      fetchImpl,
    });
    expect(calls[0]).toBe(`https://plc.test/${did}`);
    expect(key.curve).toBe("secp256k1");
    expect(key.publicKeyRaw).toEqual(kp.publicKeyRaw);
  });

  it("throws when the document has no signing key", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ id: "did:web:x.example" }), {
        status: 200,
      });
    await expect(
      resolveSigningKey("did:web:x.example", { fetchImpl }),
    ).rejects.toThrow(/no signing key/);
  });

  it("rejects an unsupported DID method", async () => {
    await expect(resolveSigningKey("did:example:123")).rejects.toThrow(
      /unsupported DID method/,
    );
  });

  it("throws SsrfError when the did:web host is private", async () => {
    await expect(
      resolveDidDocument("did:web:169.254.169.254", {
        fetchImpl: async () => new Response("{}"),
      }),
    ).rejects.toBeInstanceOf(SsrfError);
  });
});
