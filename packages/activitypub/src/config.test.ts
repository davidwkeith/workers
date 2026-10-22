import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@dwk/log";
import { SsrfError } from "@dwk/safe-fetch";

import {
  DEFAULT_USER_AGENT,
  deriveIris,
  resolveConfig,
  type ActivityPubConfig,
} from "./config.js";
import { ActivityPubLogEvent } from "./log.js";

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
    // 30-day default retention for resolved reports (#502).
    expect(resolved.reportRetentionMs).toBe(30 * 24 * 60 * 60 * 1000);
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

  it("defaults the profile-page url to the baseUrl root and honours actor.url", () => {
    expect(resolveConfig(VALID).url).toBe("https://example.com/");
    // A trailing slash on baseUrl is normalized first, so the root never doubles up.
    const slashed = resolveConfig({
      ...VALID,
      baseUrl: "https://example.com/",
    });
    expect(slashed.url).toBe("https://example.com/");
    const override = resolveConfig({
      ...VALID,
      actor: { ...VALID.actor, url: "https://example.com/about" },
    });
    expect(override.url).toBe("https://example.com/about");
  });

  it("throws when actor.url is not an absolute URL", () => {
    // A relative path would federate as a broken "open profile" link on
    // every peer — fail at startup like the other config checks instead.
    expect(() =>
      resolveConfig({ ...VALID, actor: { ...VALID.actor, url: "/about" } }),
    ).toThrow(/actor\.url/);
    expect(() =>
      resolveConfig({
        ...VALID,
        actor: { ...VALID.actor, url: "not a url" },
      }),
    ).toThrow(/actor\.url/);
  });

  it("accepts valid alsoKnownAs IRIs and rejects non-http(s) or malformed ones (#534)", () => {
    expect(
      resolveConfig({
        ...VALID,
        actor: {
          ...VALID.actor,
          alsoKnownAs: ["https://xn--4t8h.dwk.io/users/dwk"],
        },
      }).actor.alsoKnownAs,
    ).toEqual(["https://xn--4t8h.dwk.io/users/dwk"]);
    expect(() =>
      resolveConfig({
        ...VALID,
        actor: { ...VALID.actor, alsoKnownAs: ["not a url"] },
      }),
    ).toThrow(/actor\.alsoKnownAs/);
    expect(() =>
      resolveConfig({
        ...VALID,
        actor: {
          ...VALID.actor,
          alsoKnownAs: ["mailto:dwk@example.com"],
        },
      }),
    ).toThrow(/actor\.alsoKnownAs/);
  });

  it("honors explicit overrides", () => {
    const resolved = resolveConfig({
      ...VALID,
      pageSize: 10,
      deliveryMaxAttempts: 3,
      clockSkewSeconds: 60,
      reportRetentionDays: 7,
    });
    expect(resolved.pageSize).toBe(10);
    expect(resolved.deliveryMaxAttempts).toBe(3);
    expect(resolved.clockSkewSeconds).toBe(60);
    expect(resolved.reportRetentionMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("default key resolver", () => {
  const KEY_ID = "https://remote.example/users/bob#main-key";

  it("signs the key fetch as the actor when a private key is configured", async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = new Uint8Array(
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    );
    let binary = "";
    for (const b of der) binary += String.fromCharCode(b);
    const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;

    const seen: Headers[] = [];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return new Response(
          JSON.stringify({
            id: "https://remote.example/users/bob",
            publicKey: { publicKeyPem: "REMOTE-PEM" },
          }),
        );
      },
    ) as unknown as typeof fetch;

    await resolveConfig({
      ...VALID,
      privateKeyPem,
      fetch: fetchImpl,
    }).keyResolver(KEY_ID);
    expect(seen[0]?.get("signature")).toContain(
      'keyId="https://example.com/users/alice#main-key"',
    );
    expect(seen[0]?.get("signature")).toContain(
      'headers="(request-target) host date"',
    );
    expect(seen[0]?.get("host")).toBe("remote.example");
    expect(seen[0]?.get("accept")).toBe("application/activity+json");

    // Without a private key the fetch goes out unsigned, as before.
    seen.length = 0;
    await resolveConfig({ ...VALID, fetch: fetchImpl }).keyResolver(KEY_ID);
    expect(seen[0]?.has("signature")).toBe(false);
  });

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

  it("rejects a keyId that redirects to another public origin serving a spoofed owner", async () => {
    // An open redirect on the victim's own origin (`keyId` on victim.example)
    // 302s to attacker-controlled content on a *different* public origin whose
    // document claims `owner: victim.example`. The binding must compare `owner`
    // against the origin that actually SERVED the document (attacker.example),
    // not the requested `keyId` origin (victim.example), or impersonation slips
    // through.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://victim.example")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/key" },
        });
      }
      return jsonResponse({
        id: "https://attacker.example/key",
        publicKey: {
          owner: "https://victim.example/users/alice",
          publicKeyPem: "ATTACKER-PEM",
        },
      });
    });
    const resolve = resolverWith(fetchImpl as unknown as typeof fetch);
    expect(await resolve("https://victim.example/open-redirect")).toBeNull();
    // Both hops were fetched (both public), so it's the origin binding — not the
    // SSRF guard — that rejects it.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sends the resolved User-Agent, defaulting to DEFAULT_USER_AGENT", async () => {
    // Some peers' anti-scraper challenge layers (e.g. Anubis) treat an
    // unidentified client as a bot; an identifiable UA is standard ActivityPub
    // interop practice and lets such hosts allowlist federation traffic.
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/x" },
        }),
    );
    const resolve = resolverWith(fetchImpl as unknown as typeof fetch);
    await resolve(KEY_ID);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("user-agent")).toBe(
      DEFAULT_USER_AGENT,
    );
  });

  it("sends a configured User-Agent override instead of the default", async () => {
    // Composition-contract requirement: a deployment must be able to
    // identify itself specifically (e.g. with an operator contact URL), the
    // usual courtesy for peers that allowlist federation traffic by UA.
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(null, { status: 302, headers: { location: "x" } }),
    );
    const resolve = resolveConfig({
      ...VALID,
      fetch: fetchImpl as unknown as typeof fetch,
      userAgent: "my-instance/1.0 (+https://my-instance.example/)",
    }).keyResolver;
    await resolve(KEY_ID);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("user-agent")).toBe(
      "my-instance/1.0 (+https://my-instance.example/)",
    );
  });

  describe("failure diagnostics", () => {
    function resolverWithLogger(fetchImpl: typeof fetch, logger: Logger) {
      return resolveConfig({ ...VALID, fetch: fetchImpl, logger }).keyResolver;
    }

    function fakeLogger() {
      type Call = (event: string, fields?: Record<string, unknown>) => void;
      const debug = vi.fn<Call>();
      const warn = vi.fn<Call>();
      const logger: Logger = { debug, info: vi.fn(), warn, error: vi.fn() };
      return { logger, debug, warn };
    }

    it("logs the network error at warn, without the raw error message", async () => {
      // The error `message` for a redirect-loop or SsrfError embeds the full
      // requested URL(s) — per `@dwk/log`'s redaction policy (see
      // `hostFromUrl`), only sanitized hosts and machine-readable codes
      // belong in a log line, so only `error.name` is recorded here.
      const { logger, warn } = fakeLogger();
      const resolve = resolverWithLogger(
        vi.fn(async () => {
          throw new TypeError(
            `Too many redirects.${"https://remote.example/users/bob,".repeat(20)}`,
          );
        }) as unknown as typeof fetch,
        logger,
      );
      await resolve(KEY_ID);
      expect(warn).toHaveBeenCalledWith(
        ActivityPubLogEvent.KeyResolutionFailed,
        expect.objectContaining({
          reason: "fetch_error",
          host: "remote.example",
          errorName: "TypeError",
        }),
      );
      for (const call of warn.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("Too many redirects");
      }
    });

    it("logs an SsrfError's reason and host, never its message", async () => {
      const { logger, warn } = fakeLogger();
      const resolve = resolverWithLogger(
        vi.fn(async () => {
          throw new SsrfError(
            "blocked host https://169.254.169.254/latest/meta-data?secret=1",
            "blocked_host",
            "169.254.169.254",
          );
        }) as unknown as typeof fetch,
        logger,
      );
      await resolve(KEY_ID);
      expect(warn).toHaveBeenCalledWith(
        ActivityPubLogEvent.KeyResolutionFailed,
        expect.objectContaining({
          reason: "fetch_error",
          errorName: "SsrfError",
          ssrfReason: "blocked_host",
          ssrfHost: "169.254.169.254",
        }),
      );
      for (const call of warn.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("secret=1");
      }
    });

    it("logs the HTTP status on a non-ok response", async () => {
      const { logger, warn } = fakeLogger();
      const resolve = resolverWithLogger(
        vi.fn(
          async () => new Response(null, { status: 301 }),
        ) as unknown as typeof fetch,
        logger,
      );
      await resolve(KEY_ID);
      expect(warn).toHaveBeenCalledWith(
        ActivityPubLogEvent.KeyResolutionFailed,
        expect.objectContaining({
          reason: "http_status",
          host: "remote.example",
          status: 301,
        }),
      );
    });

    it("logs attacker-trivial-to-trigger failures at debug, not warn", async () => {
      // A malformed `keyId` and a malformed/missing-key document are both
      // fully attacker-controlled (the `keyId` comes off an unauthenticated
      // `Signature` header; the document comes from wherever that `keyId`
      // points), so spamming them costs an attacker nothing — `debug` keeps
      // them out of operator-facing `warn` noise.
      const { logger, debug, warn } = fakeLogger();
      const resolve = resolverWithLogger(vi.fn(), logger);
      expect(await resolve("not a url")).toBeNull();
      expect(debug).toHaveBeenCalledWith(
        ActivityPubLogEvent.KeyResolutionFailed,
        expect.objectContaining({ reason: "bad_key_id" }),
      );

      const noKeyResolve = resolverWithLogger(
        vi.fn(async () =>
          jsonResponse({ id: "https://remote.example/users/bob" }),
        ) as unknown as typeof fetch,
        logger,
      );
      expect(await noKeyResolve(KEY_ID)).toBeNull();
      expect(debug).toHaveBeenCalledWith(
        ActivityPubLogEvent.KeyResolutionFailed,
        expect.objectContaining({ reason: "no_public_key" }),
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it("logs an impersonation attempt (owner/origin mismatch) at warn", async () => {
      // Unlike the attacker-trivial cases above, a cross-origin `owner`
      // claim is a genuine impersonation attempt (or peer misconfiguration)
      // worth an operator's attention.
      const { logger, warn } = fakeLogger();
      const resolve = resolverWithLogger(
        vi.fn(async () =>
          jsonResponse({
            id: "https://evil.example/key",
            publicKey: {
              owner: "https://victim.example/users/alice",
              publicKeyPem: "ATTACKER-PEM",
            },
          }),
        ) as unknown as typeof fetch,
        logger,
      );
      expect(await resolve("https://evil.example/key")).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        ActivityPubLogEvent.KeyResolutionFailed,
        expect.objectContaining({ reason: "owner_origin_mismatch" }),
      );
    });

    it("never logs key material or document bodies", async () => {
      const { logger, debug, warn } = fakeLogger();
      const resolve = resolverWithLogger(
        vi.fn(async () =>
          jsonResponse({
            id: "https://remote.example/users/bob",
            publicKey: { owner: "x", publicKeyPem: "SECRET-PEM-MATERIAL" },
          }),
        ) as unknown as typeof fetch,
        logger,
      );
      await resolve(KEY_ID);
      // This failure (owner "x" doesn't parse as a URL) logs at `debug`, but
      // check both levels — the point is that neither one ever carries the
      // PEM, not which level this particular branch happens to use.
      for (const call of [...debug.mock.calls, ...warn.mock.calls]) {
        expect(JSON.stringify(call)).not.toContain("SECRET-PEM-MATERIAL");
      }
      expect(debug.mock.calls.length + warn.mock.calls.length).toBeGreaterThan(
        0,
      );
    });
  });
});
