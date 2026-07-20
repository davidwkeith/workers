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

  it("rejects a key document that claims a cross-origin owner (impersonation)", async () => {
    // The key is served from evil.example but declares ownership by an actor on
    // victim.example. Attributing the signature to the victim would be actor
    // impersonation, so the resolver must refuse the cross-origin ownership.
    const resolve = resolverWith(
      vi.fn(async () =>
        jsonResponse({
          id: "https://evil.example/key",
          publicKey: {
            owner: "https://victim.example/users/alice",
            publicKeyPem: "ATTACKER-PEM",
          },
        }),
      ) as unknown as typeof fetch,
    );
    expect(await resolve("https://evil.example/key")).toBeNull();
  });

  it("rejects a plaintext http: keyId without fetching (SSRF guard)", async () => {
    const fetchImpl = vi.fn();
    const resolve = resolverWith(fetchImpl as unknown as typeof fetch);
    expect(
      await resolve("http://remote.example/users/bob#main-key"),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a private/loopback-host keyId without fetching (SSRF guard)", async () => {
    const fetchImpl = vi.fn();
    const resolve = resolverWith(fetchImpl as unknown as typeof fetch);
    expect(await resolve("https://127.0.0.1/key")).toBeNull();
    expect(
      await resolve("https://169.254.169.254/latest/meta-data"),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a keyId that redirects to a private host (hop-by-hop SSRF)", async () => {
    // The initial URL is a syntactically-fine public HTTPS host (passes the
    // first check), but it 302s to a link-local metadata address. Because the
    // fetch re-validates every redirect hop, the private target is refused.
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data" },
        }),
    );
    const resolve = resolverWith(fetchImpl as unknown as typeof fetch);
    expect(await resolve("https://public.example/key")).toBeNull();
    // The redirect hop to the private host was never fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
