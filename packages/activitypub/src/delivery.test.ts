import { describe, expect, it, vi } from "vitest";

import {
  assertPublicHttpsTarget,
  deliverActivity,
  DeliveryBlockedError,
  type DeliveryResult,
} from "./delivery.js";

// A throwaway RSA key is unnecessary for the SSRF/result-classification tests;
// only deliverActivity's success/failure path signs, so we generate one there.
const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

async function privateKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(RSA, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  let binary = "";
  for (const b of der) binary += String.fromCharCode(b);
  const b64 =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
}

describe("assertPublicHttpsTarget", () => {
  it("accepts a public https URL", () => {
    expect(() =>
      assertPublicHttpsTarget("https://mastodon.social/inbox"),
    ).not.toThrow();
  });

  it("rejects non-https schemes", () => {
    expect(() => assertPublicHttpsTarget("http://example.com/inbox")).toThrow(
      DeliveryBlockedError,
    );
  });

  it.each([
    "https://127.0.0.1/inbox",
    "https://10.1.2.3/inbox",
    "https://192.168.0.1/inbox",
    "https://172.16.0.9/inbox",
    "https://169.254.169.254/inbox",
    "https://localhost/inbox",
    "https://foo.internal/inbox",
    "https://[::1]/inbox",
    "https://example.onion/inbox",
  ])("rejects private/loopback target %s", (url) => {
    expect(() => assertPublicHttpsTarget(url)).toThrow(DeliveryBlockedError);
  });

  it("rejects a malformed URL", () => {
    try {
      assertPublicHttpsTarget("not a url");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DeliveryBlockedError);
      expect((error as DeliveryBlockedError).reason).toBe("invalid_url");
    }
  });
});

describe("deliverActivity", () => {
  it("signs the request and reports success on 2xx", async () => {
    const pem = await privateKeyPem();
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(null, { status: 202 }),
    ) as unknown as typeof fetch;

    const result = await deliverActivity(
      "https://remote.example/inbox",
      JSON.stringify({ type: "Accept" }),
      { keyId: "https://example.com/users/bob#main-key", privateKeyPem: pem },
      fetchImpl,
    );

    expect(result).toEqual<DeliveryResult>({ ok: true, status: 202 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Signature).toContain('keyId="');
    expect(headers.Digest).toMatch(/^SHA-256=/);
    expect(headers.Date).toBeTruthy();
  });

  it("classifies a 4xx as a permanent (non-retryable) failure", async () => {
    const pem = await privateKeyPem();
    const fetchImpl = (async () =>
      new Response("bad", { status: 400 })) as unknown as typeof fetch;
    const result = await deliverActivity(
      "https://remote.example/inbox",
      "{}",
      { keyId: "k", privateKeyPem: pem },
      fetchImpl,
    );
    expect(result).toEqual({ ok: false, status: 400, retryable: false });
  });

  it("classifies a 5xx and network errors as retryable", async () => {
    const pem = await privateKeyPem();
    const five = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(
      await deliverActivity(
        "https://remote.example/inbox",
        "{}",
        {
          keyId: "k",
          privateKeyPem: pem,
        },
        five,
      ),
    ).toEqual({ ok: false, status: 503, retryable: true });

    const boom = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(
      await deliverActivity(
        "https://remote.example/inbox",
        "{}",
        {
          keyId: "k",
          privateKeyPem: pem,
        },
        boom,
      ),
    ).toEqual({ ok: false, status: 0, retryable: true });
  });

  it("blocks an unsafe target before any fetch", async () => {
    const pem = await privateKeyPem();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      deliverActivity(
        "https://127.0.0.1/inbox",
        "{}",
        {
          keyId: "k",
          privateKeyPem: pem,
        },
        fetchImpl,
      ),
    ).rejects.toBeInstanceOf(DeliveryBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
