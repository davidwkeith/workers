import { describe, expect, it, vi } from "vitest";

import { deriveIris, resolveConfig, type ActivityPubConfig } from "./config.js";

/**
 * Tests for config resolution and the default key resolver. The resolver is the
 * package's only outbound key-fetch path, so its rejection branches (a slow or
 * malformed peer must map to `null`, never a thrown error) are pinned here.
 */

const VALID: ActivityPubConfig = {
  baseUrl: "https://example.com",
  actor: { username: "alice" },
  publicKeyPem: "PUBLIC-PEM",
};

describe("resolveConfig validation", () => {
  it("throws when baseUrl is missing", () => {
    expect(() => resolveConfig({ ...VALID, baseUrl: "" })).toThrow(/baseUrl/);
  });

  it("throws when actor.username is missing", () => {
    expect(() => resolveConfig({ ...VALID, actor: { username: "" } })).toThrow(
      /username/,
    );
  });

  it("throws when publicKeyPem is missing", () => {
    expect(() => resolveConfig({ ...VALID, publicKeyPem: "" })).toThrow(
      /publicKeyPem/,
    );
  });
});

describe("resolveConfig defaults and derivation", () => {
  it("applies defaults and derives the actor IRIs", () => {
    const resolved = resolveConfig(VALID);
    expect(resolved.pageSize).toBe(50);
    expect(resolved.deliveryMaxAttempts).toBe(8);
    expect(resolved.deliveryBaseDelayMs).toBe(60_000);
    expect(resolved.clockSkewSeconds).toBe(300);
    expect(resolved.software.name).toBe("dwk-activitypub");
    expect(resolved.iris).toEqual(deriveIris("https://example.com", "alice"));
    // Relay verification (§2.2) is on by default, in the tiered mode.
    expect(resolved.verifyRelayedObjects).toBe("tiered");
  });

  it("honors an explicit relay-verification mode", () => {
    expect(
      resolveConfig({ ...VALID, verifyRelayedObjects: "off" })
        .verifyRelayedObjects,
    ).toBe("off");
  });

  it("strips a trailing slash from baseUrl before deriving IRIs", () => {
    const resolved = resolveConfig({
      ...VALID,
      baseUrl: "https://example.com/",
    });
    expect(resolved.baseUrl).toBe("https://example.com");
    expect(resolved.iris.id).toBe("https://example.com/users/alice");
  });

  it("derives the FEP-2c59 webfinger handle from the baseUrl hostname", () => {
    expect(resolveConfig(VALID).webfinger).toBe("acct:alice@example.com");
    // The port is never part of a WebFinger handle, even on a non-standard one.
    const ported = resolveConfig({
      ...VALID,
      baseUrl: "https://example.com:8080",
    });
    expect(ported.webfinger).toBe("acct:alice@example.com");
    // An explicit acctDomain wins over the derived hostname.
    const override = resolveConfig({ ...VALID, acctDomain: "handles.example" });
    expect(override.webfinger).toBe("acct:alice@handles.example");
  });

  it("honors explicit overrides", () => {
    const resolved = resolveConfig({
      ...VALID,
      pageSize: 10,
      deliveryMaxAttempts: 3,
      clockSkewSeconds: 60,
    });
    expect(resolved.pageSize).toBe(10);
    expect(resolved.deliveryMaxAttempts).toBe(3);
    expect(resolved.clockSkewSeconds).toBe(60);
  });
});

describe("default key resolver", () => {
  const KEY_ID = "https://remote.example/users/bob#main-key";

  function resolverWith(fetchImpl: typeof fetch) {
    return resolveConfig({ ...VALID, fetch: fetchImpl }).keyResolver;
  }

  function jsonResponse(body: unknown, ok = true): Response {
    return new Response(JSON.stringify(body), {
      status: ok ? 200 : 502,
    });
  }

  it("reads owner + PEM from an actor document's publicKey", async () => {
    const resolve = resolverWith(
      vi.fn(async () =>
        jsonResponse({
          id: "https://remote.example/users/bob",
          publicKey: {
            owner: "https://remote.example/users/bob",
            publicKeyPem: "REMOTE-PEM",
          },
        }),
      ) as unknown as typeof fetch,
    );
    expect(await resolve(KEY_ID)).toEqual({
      owner: "https://remote.example/users/bob",
      publicKeyPem: "REMOTE-PEM",
    });
  });

  it("falls back to the document id when publicKey.owner is absent", async () => {
    const resolve = resolverWith(
      vi.fn(async () =>
        jsonResponse({
          id: "https://remote.example/users/bob",
          publicKey: { publicKeyPem: "REMOTE-PEM" },
        }),
      ) as unknown as typeof fetch,
    );
    expect(await resolve(KEY_ID)).toEqual({
      owner: "https://remote.example/users/bob",
      publicKeyPem: "REMOTE-PEM",
    });
  });

  it("returns null when the keyId has no actor URL", async () => {
    const fetchImpl = vi.fn();
    const resolve = resolverWith(fetchImpl as unknown as typeof fetch);
    expect(await resolve("#main-key")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) keyId without fetching", async () => {
    const fetchImpl = vi.fn();
    const resolve = resolverWith(fetchImpl as unknown as typeof fetch);
    // A `data:` keyId could otherwise smuggle an attacker-chosen key past
    // signature verification on runtimes whose `fetch` dereferences it.
    expect(
      await resolve("data:application/json,%7B%22publicKeyPem%22%3A%22x%22%7D"),
    ).toBeNull();
    expect(await resolve("file:///etc/passwd")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the fetch throws", async () => {
    const resolve = resolverWith(
      vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    );
    expect(await resolve(KEY_ID)).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    const resolve = resolverWith(
      vi.fn(async () => jsonResponse({}, false)) as unknown as typeof fetch,
    );
    expect(await resolve(KEY_ID)).toBeNull();
  });

  it("returns null when the body is not JSON", async () => {
    const resolve = resolverWith(
      vi.fn(async () => new Response("<html>")) as unknown as typeof fetch,
    );
    expect(await resolve(KEY_ID)).toBeNull();
  });

  it("returns null when the document carries no publicKey", async () => {
    const resolve = resolverWith(
      vi.fn(async () =>
        jsonResponse({ id: "https://remote.example/users/bob" }),
      ) as unknown as typeof fetch,
    );
    expect(await resolve(KEY_ID)).toBeNull();
  });

  it("returns null when publicKeyPem is not a string", async () => {
    const resolve = resolverWith(
      vi.fn(async () =>
        jsonResponse({
          id: "https://remote.example/users/bob",
          publicKey: { owner: "x", publicKeyPem: 42 },
        }),
      ) as unknown as typeof fetch,
    );
    expect(await resolve(KEY_ID)).toBeNull();
  });
});
