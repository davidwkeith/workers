import { describe, expect, it, vi } from "vitest";

import type { JsonObject } from "./data-integrity.js";
import {
  buildDidDocument,
  createDidWebResolver,
  didWebToUrl,
  findVerificationMethod,
  urlToDidWeb,
} from "./did-web.js";

describe("didWebToUrl", () => {
  it("maps a bare host to the well-known path", () => {
    expect(didWebToUrl("did:web:example.com")).toBe(
      "https://example.com/.well-known/did.json",
    );
  });

  it("maps path components to a path", () => {
    expect(didWebToUrl("did:web:example.com:user:alice")).toBe(
      "https://example.com/user/alice/did.json",
    );
  });

  it("decodes a percent-encoded port", () => {
    expect(didWebToUrl("did:web:localhost%3A8443")).toBe(
      "https://localhost:8443/.well-known/did.json",
    );
  });

  it("rejects a non-did:web identifier", () => {
    expect(() => didWebToUrl("did:key:z6Mk")).toThrow(/not a did:web/);
  });

  it("rejects path-traversal segments", () => {
    expect(() => didWebToUrl("did:web:example.com:..:secret")).toThrow(
      /invalid path segment/,
    );
    // `.` and `..` only reachable via percent-encoding are also rejected.
    expect(() => didWebToUrl("did:web:example.com:%2e%2e")).toThrow(
      /invalid path segment/,
    );
  });
});

describe("urlToDidWeb", () => {
  it("maps an origin to a bare did:web", () => {
    expect(urlToDidWeb("https://example.com")).toBe("did:web:example.com");
    expect(urlToDidWeb("example.com")).toBe("did:web:example.com");
  });

  it("encodes a port and maps path segments", () => {
    expect(urlToDidWeb("https://localhost:8443")).toBe(
      "did:web:localhost%3A8443",
    );
    expect(urlToDidWeb("https://example.com/user/alice")).toBe(
      "did:web:example.com:user:alice",
    );
  });

  it("round-trips with didWebToUrl", () => {
    const did = "did:web:example.com:issuers:1";
    expect(urlToDidWeb(didWebToUrl(did))).toBe(did);
  });
});

describe("buildDidDocument", () => {
  it("emits contexts, methods, and assertionMethod by default", () => {
    const doc = buildDidDocument({
      did: "did:web:example.com",
      verificationMethods: [
        { id: "#key-0", publicKeyMultibase: "z6MkExample" },
      ],
    });
    expect(doc.id).toBe("did:web:example.com");
    expect(doc["@context"]).toContain("https://www.w3.org/ns/did/v1");
    expect(doc.assertionMethod).toEqual(["did:web:example.com#key-0"]);
    const vm = (doc.verificationMethod as JsonObject[])[0]!;
    expect(vm.id).toBe("did:web:example.com#key-0");
    expect(vm.controller).toBe("did:web:example.com");
    expect(vm.type).toBe("Multikey");
  });

  it("adds the JWK context for a JWK method and supports authentication", () => {
    const doc = buildDidDocument({
      did: "did:web:example.com",
      verificationMethods: [
        {
          id: "#key-0",
          publicKeyJwk: { kty: "EC", crv: "P-256", x: "a", y: "b" },
        },
      ],
      relationships: { assertionMethod: true, authentication: true },
    });
    expect(doc["@context"]).toContain("https://w3id.org/security/jwk/v1");
    expect(doc.authentication).toEqual(["did:web:example.com#key-0"]);
  });

  it("throws without any verification method", () => {
    expect(() =>
      buildDidDocument({ did: "did:web:example.com", verificationMethods: [] }),
    ).toThrow(/at least one/);
  });
});

describe("findVerificationMethod / createDidWebResolver", () => {
  const didDoc: JsonObject = {
    id: "did:web:example.com",
    verificationMethod: [
      {
        id: "did:web:example.com#key-0",
        type: "Multikey",
        publicKeyMultibase: "z6Mk",
      },
    ],
  };

  it("finds a method by id", () => {
    const vm = findVerificationMethod(didDoc, "did:web:example.com#key-0");
    expect(vm?.publicKeyMultibase).toBe("z6Mk");
    expect(
      findVerificationMethod(didDoc, "did:web:example.com#missing"),
    ).toBeUndefined();
  });

  it("resolves a relative method id against the document id", () => {
    const relativeDoc: JsonObject = {
      id: "did:web:example.com",
      verificationMethod: [
        { id: "#key-0", type: "Multikey", publicKeyMultibase: "z6Mk" },
      ],
    };
    const vm = findVerificationMethod(relativeDoc, "did:web:example.com#key-0");
    expect(vm?.publicKeyMultibase).toBe("z6Mk");
  });

  it("resolves via an injected fetch and ignores non-did:web ids", async () => {
    const resolve = createDidWebResolver({
      fetch: async (url) => {
        expect(url).toBe("https://example.com/.well-known/did.json");
        return new Response(JSON.stringify(didDoc));
      },
    });
    const vm = await resolve("did:web:example.com#key-0");
    expect(vm?.publicKeyMultibase).toBe("z6Mk");
    expect(await resolve("did:key:z6Mk#k")).toBeUndefined();
  });

  it("returns undefined on fetch failure", async () => {
    const resolve = createDidWebResolver({
      fetch: async () => new Response("", { status: 404 }),
    });
    expect(await resolve("did:web:example.com#key-0")).toBeUndefined();
  });

  it("does not return an entry whose type fields are the wrong shape", () => {
    const didDocument = {
      id: "did:web:example.com",
      verificationMethod: [
        {
          id: "did:web:example.com#key-0",
          type: 12345, // wrong shape: should be a string
          controller: "did:web:example.com",
          publicKeyJwk: { kty: "EC" },
        },
      ],
    };
    expect(
      findVerificationMethod(didDocument, "did:web:example.com#key-0"),
    ).toBeUndefined();
  });

  it("does not return an entry whose publicKeyJwk is an array instead of an object", () => {
    const didDocument = {
      id: "did:web:example.com",
      verificationMethod: [
        {
          id: "did:web:example.com#key-0",
          type: "JsonWebKey2020",
          publicKeyJwk: ["not", "an", "object"],
        },
      ],
    };
    expect(
      findVerificationMethod(didDocument, "did:web:example.com#key-0"),
    ).toBeUndefined();
  });
});

describe("createDidWebResolver fetchAllowedHosts (local-dev opt-in, issue #257)", () => {
  const localDoc: JsonObject = {
    id: "did:web:localhost%3A4321",
    verificationMethod: [
      {
        id: "did:web:localhost%3A4321#key-0",
        type: "Multikey",
        publicKeyMultibase: "z6Mk",
      },
    ],
  };

  it("resolves a loopback did:web when its host is allowlisted", async () => {
    const resolve = createDidWebResolver({
      fetch: async (url) => {
        expect(url).toBe("https://localhost:4321/.well-known/did.json");
        return new Response(JSON.stringify(localDoc));
      },
      fetchAllowedHosts: ["localhost:4321"],
    });
    const vm = await resolve("did:web:localhost%3A4321#key-0");
    expect(vm?.publicKeyMultibase).toBe("z6Mk");
  });

  it("still refuses a loopback did:web without the allowlist entry", async () => {
    const doFetch = vi.fn(async () => new Response(JSON.stringify(localDoc)));
    const resolve = createDidWebResolver({ fetch: doFetch });
    expect(await resolve("did:web:localhost%3A4321#key-0")).toBeUndefined();
    expect(doFetch).not.toHaveBeenCalled();
  });
});
