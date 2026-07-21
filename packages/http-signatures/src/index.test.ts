import { beforeAll, describe, expect, it } from "vitest";

import {
  createContentDigest,
  createDigest,
  isSupportedAlgorithm,
  signMessage,
  verifyContentDigest,
  verifyMessage,
  type HttpMessage,
  type KeyResolver,
  type SignatureAlgorithm,
} from "./index.js";

// --- key fixtures -----------------------------------------------------------

interface KeyFixture {
  alg: SignatureAlgorithm;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

async function generate(alg: SignatureAlgorithm): Promise<KeyFixture> {
  let params: object;
  switch (alg) {
    case "rsa-v1_5-sha256":
      params = {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      };
      break;
    case "rsa-pss-sha512":
      params = {
        name: "RSA-PSS",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-512",
      };
      break;
    case "ecdsa-p256-sha256":
      params = { name: "ECDSA", namedCurve: "P-256" };
      break;
    case "ecdsa-p384-sha384":
      params = { name: "ECDSA", namedCurve: "P-384" };
      break;
    case "ed25519":
      params = { name: "Ed25519" };
      break;
  }
  const pair = (await crypto.subtle.generateKey(
    params as Parameters<typeof crypto.subtle.generateKey>[0],
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return { alg, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

const ALL_ALGS: SignatureAlgorithm[] = [
  "rsa-v1_5-sha256",
  "rsa-pss-sha512",
  "ecdsa-p256-sha256",
  "ecdsa-p384-sha384",
  "ed25519",
];

const keys: Partial<Record<SignatureAlgorithm, KeyFixture>> = {};

beforeAll(async () => {
  for (const alg of ALL_ALGS) {
    keys[alg] = await generate(alg);
  }
});

function resolverFor(key: CryptoKey): KeyResolver {
  return () => key;
}

function baseMessage(): HttpMessage {
  return {
    method: "POST",
    url: "https://example.com/inbox?foo=1",
    headers: {
      host: "example.com",
      date: "Tue, 20 Apr 2021 02:07:55 GMT",
      "content-type": "application/activity+json",
    },
  };
}

const NOW = 1_700_000_000;

// --- RFC 9421 ---------------------------------------------------------------

describe("RFC 9421 round-trip", () => {
  it.each(ALL_ALGS)("signs and verifies with %s", async (alg) => {
    const k = keys[alg]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      key: k.privateKey,
      keyId: "https://example.com/actor#main-key",
      alg,
      components: ["@method", "@target-uri", "@authority", "host", "date"],
      created: NOW,
    });
    expect(headers["Signature-Input"]).toContain(`alg="${alg}"`);

    const received: HttpMessage = {
      ...message,
      headers: { ...message.headers, ...headers },
    };
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
    });
    expect(result).toMatchObject({
      valid: true,
      profile: "rfc9421",
      label: "sig1",
      keyId: "https://example.com/actor#main-key",
      created: NOW,
    });
    expect(result.coveredComponents).toEqual([
      "@method",
      "@target-uri",
      "@authority",
      "host",
      "date",
    ]);
  });

  it("passes the resolved keyId and alg to the resolver", async () => {
    const k = keys["ed25519"]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      key: k.privateKey,
      keyId: "key-7",
      alg: "ed25519",
      components: ["@method", "host"],
      created: NOW,
    });
    let seen:
      { keyId: string | null; alg: SignatureAlgorithm | null } | undefined;
    await verifyMessage(
      { ...message, headers: { ...message.headers, ...headers } },
      {
        resolveKey: (p) => {
          seen = p;
          return k.publicKey;
        },
        now: NOW,
      },
    );
    expect(seen).toEqual({ keyId: "key-7", alg: "ed25519" });
  });
});

describe("RFC 9421 failure modes", () => {
  async function signed(overrides: Partial<HttpMessage> = {}) {
    const k = keys["ecdsa-p256-sha256"]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      key: k.privateKey,
      keyId: "k",
      alg: "ecdsa-p256-sha256",
      components: ["@method", "@target-uri", "host", "date"],
      created: NOW,
    });
    return {
      k,
      received: {
        ...message,
        ...overrides,
        headers: {
          ...message.headers,
          ...headers,
          ...(overrides.headers ?? {}),
        },
      } as HttpMessage,
    };
  }

  it("rejects a tampered covered header", async () => {
    const { k, received } = await signed();
    received.headers = {
      ...received.headers,
      date: "Wed, 21 Apr 2021 00:00:00 GMT",
    };
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
    });
    expect(result).toMatchObject({ valid: false, reason: "signature_invalid" });
  });

  it("rejects a tampered method (a derived component)", async () => {
    const { k, received } = await signed();
    received.method = "GET";
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
    });
    expect(result.reason).toBe("signature_invalid");
  });

  it("rejects the wrong key", async () => {
    const { received } = await signed();
    const wrong = await generate("ecdsa-p256-sha256");
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(wrong.publicKey),
      now: NOW,
    });
    expect(result.reason).toBe("signature_invalid");
  });

  it("reports an unresolved key", async () => {
    const { received } = await signed();
    const result = await verifyMessage(received, {
      resolveKey: () => null,
      now: NOW,
    });
    expect(result.reason).toBe("key_unresolved");
  });

  it("rejects an expired signature", async () => {
    const k = keys["ecdsa-p256-sha256"]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      key: k.privateKey,
      keyId: "k",
      alg: "ecdsa-p256-sha256",
      components: ["@method", "host"],
      created: NOW,
      expires: NOW + 60,
    });
    const result = await verifyMessage(
      { ...message, headers: { ...message.headers, ...headers } },
      {
        resolveKey: resolverFor(k.publicKey),
        now: NOW + 1000,
        toleranceSeconds: 5,
      },
    );
    expect(result.reason).toBe("signature_expired");
  });

  it("rejects a signature created in the future", async () => {
    const k = keys["ecdsa-p256-sha256"]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      key: k.privateKey,
      keyId: "k",
      alg: "ecdsa-p256-sha256",
      components: ["@method", "host"],
      created: NOW + 10_000,
    });
    const result = await verifyMessage(
      { ...message, headers: { ...message.headers, ...headers } },
      { resolveKey: resolverFor(k.publicKey), now: NOW, toleranceSeconds: 5 },
    );
    expect(result.reason).toBe("signature_future");
  });

  it("rejects a signature whose created is older than the max age (no expires)", async () => {
    const k = keys["ecdsa-p256-sha256"]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      key: k.privateKey,
      keyId: "k",
      alg: "ecdsa-p256-sha256",
      components: ["@method", "host"],
      created: NOW,
    });
    // Verify far in the future (> the 3600s default window) with no `expires`.
    const result = await verifyMessage(
      { ...message, headers: { ...message.headers, ...headers } },
      {
        resolveKey: resolverFor(k.publicKey),
        now: NOW + 100_000,
        toleranceSeconds: 5,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("created_stale");
  });

  it("rejects an aged created as created_stale even with a long expires still in the future", async () => {
    // A signer set a generous `expires` (2h past `created`), but verification
    // happens 90 min later — past the default 3600s max age. The unconditional
    // created max-age bound rejects it despite `expires` not having passed.
    const k = keys["ecdsa-p256-sha256"]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      key: k.privateKey,
      keyId: "k",
      alg: "ecdsa-p256-sha256",
      components: ["@method", "host"],
      created: NOW,
      expires: NOW + 7200,
    });
    const received = {
      ...message,
      headers: { ...message.headers, ...headers },
    };
    // Default maxAgeSeconds → created_stale…
    const stale = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW + 5400,
      toleranceSeconds: 5,
    });
    expect(stale.valid).toBe(false);
    expect(stale.reason).toBe("created_stale");
    // …but a caller whose maxAgeSeconds matches the expires policy accepts it.
    const ok = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW + 5400,
      toleranceSeconds: 5,
      maxAgeSeconds: 7200,
    });
    expect(ok.valid).toBe(true);
  });

  it("accepts an old created when maxAgeSeconds is Infinity (bound disabled)", async () => {
    const k = keys["ecdsa-p256-sha256"]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      key: k.privateKey,
      keyId: "k",
      alg: "ecdsa-p256-sha256",
      components: ["@method", "host"],
      created: NOW,
    });
    const result = await verifyMessage(
      { ...message, headers: { ...message.headers, ...headers } },
      {
        resolveKey: resolverFor(k.publicKey),
        now: NOW + 100_000,
        toleranceSeconds: 5,
        maxAgeSeconds: Infinity,
      },
    );
    expect(result.valid).toBe(true);
  });

  it("enforces required components", async () => {
    const { k, received } = await signed();
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
      requiredComponents: ["@method", "content-digest"],
    });
    expect(result.reason).toBe("required_component_missing");
  });

  it("rejects an unsupported algorithm in the header", async () => {
    const k = keys["ecdsa-p256-sha256"]!;
    const received: HttpMessage = {
      ...baseMessage(),
      headers: {
        ...baseMessage().headers,
        "signature-input": `sig1=("@method");created=${NOW};keyid="k";alg="hmac-sha256"`,
        signature: "sig1=:AAAA:",
      },
    };
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
    });
    expect(result.reason).toBe("alg_unsupported");
  });

  it("rejects a missing keyid", async () => {
    const k = keys["ecdsa-p256-sha256"]!;
    const received: HttpMessage = {
      ...baseMessage(),
      headers: {
        ...baseMessage().headers,
        "signature-input": `sig1=("@method");created=${NOW};alg="ecdsa-p256-sha256"`,
        signature: "sig1=:AAAA:",
      },
    };
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
    });
    expect(result.reason).toBe("keyid_missing");
  });

  it("rejects unsupported component parameters", async () => {
    const k = keys["ecdsa-p256-sha256"]!;
    const received: HttpMessage = {
      ...baseMessage(),
      headers: {
        ...baseMessage().headers,
        "signature-input": `sig1=("@method";key="x");created=${NOW};keyid="k";alg="ecdsa-p256-sha256"`,
        signature: "sig1=:AAAA:",
      },
    };
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
    });
    expect(result.reason).toBe("components_malformed");
  });

  it("rejects a repeated covered component on verify (RFC 9421 §2)", async () => {
    const k = keys["ecdsa-p256-sha256"]!;
    const received: HttpMessage = {
      ...baseMessage(),
      headers: {
        ...baseMessage().headers,
        "signature-input": `sig1=("@method" "@method");created=${NOW};keyid="k";alg="ecdsa-p256-sha256"`,
        signature: "sig1=:AAAA:",
      },
    };
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
    });
    expect(result.reason).toBe("components_malformed");
  });

  it("rejects a repeated covered component on sign (RFC 9421 §2)", async () => {
    const k = keys["ed25519"]!;
    await expect(
      signMessage(baseMessage(), {
        key: k.privateKey,
        keyId: "k",
        alg: "ed25519",
        components: ["@method", "@method"],
        created: NOW,
      }),
    ).rejects.toThrow(/duplicate covered component/);
  });

  it("reports a missing signature header", async () => {
    const result = await verifyMessage(baseMessage(), {
      resolveKey: () => null,
      now: NOW,
    });
    expect(result.reason).toBe("signature_missing");
  });

  it("rejects an undersized RSA key", async () => {
    const small = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 1024,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const message = baseMessage();
    const headers = await signMessage(message, {
      key: small.privateKey,
      keyId: "k",
      alg: "rsa-v1_5-sha256",
      components: ["@method", "host"],
      created: NOW,
    });
    const result = await verifyMessage(
      { ...message, headers: { ...message.headers, ...headers } },
      { resolveKey: resolverFor(small.publicKey), now: NOW },
    );
    expect(result.reason).toBe("key_too_small");
  });

  it("flags an ambiguous label when more than one signature is present", async () => {
    const k = keys["ed25519"]!;
    const message = baseMessage();
    const a = await signMessage(message, {
      key: k.privateKey,
      keyId: "k",
      alg: "ed25519",
      components: ["@method"],
      created: NOW,
      label: "sig1",
    });
    const b = await signMessage(message, {
      key: k.privateKey,
      keyId: "k",
      alg: "ed25519",
      components: ["@method"],
      created: NOW,
      label: "sig2",
    });
    const received: HttpMessage = {
      ...message,
      headers: {
        ...message.headers,
        "signature-input": `${a["Signature-Input"]}, ${b["Signature-Input"]}`,
        signature: `${a.Signature}, ${b.Signature}`,
      },
    };
    const ambiguous = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
    });
    expect(ambiguous.reason).toBe("label_ambiguous");

    const picked = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
      label: "sig2",
    });
    expect(picked).toMatchObject({ valid: true, label: "sig2" });
  });

  it("derives the algorithm from the key when alg is omitted (RFC 9421 §2.3)", async () => {
    const k = keys["ed25519"]!;
    // Hand-build a signature whose Signature-Input carries no `alg` parameter.
    const sigParams = `("@method" "host");created=${NOW};keyid="k"`;
    const base = `"@method": POST\n"host": example.com\n"@signature-params": ${sigParams}`;
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        k.privateKey,
        new TextEncoder().encode(base),
      ),
    );
    const b64 = btoa(String.fromCharCode(...sig));
    const received: HttpMessage = {
      ...baseMessage(),
      headers: {
        ...baseMessage().headers,
        "signature-input": `sig1=${sigParams}`,
        signature: `sig1=:${b64}:`,
      },
    };
    let seenAlg: SignatureAlgorithm | null | undefined;
    const result = await verifyMessage(received, {
      resolveKey: ({ alg }) => {
        seenAlg = alg;
        return k.publicKey;
      },
      now: NOW,
    });
    expect(seenAlg).toBeNull();
    expect(result.valid).toBe(true);
  });

  it("rejects expires before created", async () => {
    const k = keys["ecdsa-p256-sha256"]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      key: k.privateKey,
      keyId: "k",
      alg: "ecdsa-p256-sha256",
      components: ["@method", "host"],
      created: NOW,
      expires: NOW - 100,
    });
    const result = await verifyMessage(
      { ...message, headers: { ...message.headers, ...headers } },
      { resolveKey: resolverFor(k.publicKey), now: NOW },
    );
    expect(result.reason).toBe("expires_invalid");
  });
});

// --- Content-Digest ---------------------------------------------------------

describe("Content-Digest", () => {
  it("emits and verifies the RFC 9530 format", async () => {
    const body = '{"type":"Create"}';
    const cd = await createContentDigest(body);
    expect(cd).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
    expect(await verifyContentDigest(cd, body)).toBeNull();
    expect(await verifyContentDigest(cd, "tampered")).toBe("digest_mismatch");
  });

  it("supports sha-512", async () => {
    const body = "hello";
    const cd = await createContentDigest(body, "sha-512");
    expect(cd.startsWith("sha-512=:")).toBe(true);
    expect(await verifyContentDigest(cd, body)).toBeNull();
  });

  it("ignores unsupported algorithms when a supported one verifies (RFC 9530 §3)", async () => {
    const body = '{"type":"Create"}';
    const cd = await createContentDigest(body);
    // A supported entry alongside one this verifier does not implement.
    expect(await verifyContentDigest(`md5=:AAAA:, ${cd}`, body)).toBeNull();
    // Only an unsupported entry: nothing to verify against.
    expect(await verifyContentDigest("md5=:AAAA:", body)).toBe(
      "digest_unsupported",
    );
  });

  it("parses the field as an RFC 8941 dictionary", async () => {
    const body = '{"type":"Create"}';
    const cd = await createContentDigest(body);
    // An uppercase algorithm key is not a valid sf-key: reject, do not lowercase.
    expect(await verifyContentDigest(cd.toUpperCase(), body)).toBe(
      "digest_mismatch",
    );
    // A member carrying parameters is parsed as a byte sequence, not mis-split.
    expect(await verifyContentDigest(`${cd};foo=bar`, body)).toBeNull();
    // A malformed (non-byte-sequence) value fails closed.
    expect(await verifyContentDigest("sha-256=notbytes", body)).toBe(
      "digest_mismatch",
    );
  });

  it("verifies a covered digest against the body during verification", async () => {
    const k = keys["ed25519"]!;
    const body = '{"type":"Create","actor":"https://example.com/actor"}';
    const message = baseMessage();
    message.headers["content-digest"] = await createContentDigest(body);
    const headers = await signMessage(message, {
      key: k.privateKey,
      keyId: "k",
      alg: "ed25519",
      components: ["@method", "@target-uri", "content-digest"],
      created: NOW,
    });
    const received: HttpMessage = {
      ...message,
      headers: { ...message.headers, ...headers },
    };

    const ok = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
      body,
    });
    expect(ok.valid).toBe(true);

    const bad = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
      body: '{"type":"Delete"}',
    });
    expect(bad).toMatchObject({ valid: false, reason: "digest_mismatch" });
  });

  it("requireBodyDigest fails a body-bearing message whose signature covers no digest", async () => {
    const k = keys["ed25519"]!;
    const body = '{"type":"Create","actor":"https://example.com/actor"}';
    const message = baseMessage();
    const headers = await signMessage(message, {
      key: k.privateKey,
      keyId: "k",
      alg: "ed25519",
      components: ["@method", "@target-uri"],
      created: NOW,
    });
    const received: HttpMessage = {
      ...message,
      headers: { ...message.headers, ...headers },
    };

    // Without requireBodyDigest, the body is simply never checked.
    const unverified = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
      body,
    });
    expect(unverified.valid).toBe(true);

    // With it, a body handed in without a covered digest component is rejected.
    const rejected = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
      body,
      requireBodyDigest: true,
    });
    expect(rejected).toMatchObject({
      valid: false,
      reason: "body_digest_required",
    });

    // A signature with no body at all is unaffected by the option.
    const noBody = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
      requireBodyDigest: true,
    });
    expect(noBody.valid).toBe(true);
  });
});

// --- draft-cavage -----------------------------------------------------------

describe("draft-cavage round-trip", () => {
  it("signs and verifies the rsa-sha256 fediverse profile", async () => {
    const k = keys["rsa-v1_5-sha256"]!;
    const body = '{"type":"Follow"}';
    const message = baseMessage();
    message.headers["digest"] = await createDigest(body);
    const headers = await signMessage(message, {
      profile: "cavage",
      key: k.privateKey,
      keyId: "https://example.com/actor#main-key",
      alg: "rsa-v1_5-sha256",
      components: ["(request-target)", "host", "date", "digest"],
    });
    expect(headers.Signature).toContain('algorithm="rsa-sha256"');
    expect(headers.Signature).toContain(
      'headers="(request-target) host date digest"',
    );

    const received: HttpMessage = {
      ...message,
      headers: { ...message.headers, ...headers },
    };
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
      body,
    });
    expect(result).toMatchObject({
      valid: true,
      profile: "cavage",
      keyId: "https://example.com/actor#main-key",
    });
    expect(result.coveredComponents).toEqual([
      "(request-target)",
      "host",
      "date",
      "digest",
    ]);
  });

  it("verifies the (created)/(expires) pseudo-headers and hs2019", async () => {
    const k = keys["rsa-pss-sha512"]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      profile: "cavage",
      key: k.privateKey,
      keyId: "k",
      alg: "rsa-pss-sha512", // serialized as hs2019
      components: ["(request-target)", "(created)", "(expires)", "host"],
      created: NOW,
      expires: NOW + 300,
    });
    expect(headers.Signature).toContain('algorithm="hs2019"');
    const received: HttpMessage = {
      ...message,
      headers: { ...message.headers, ...headers },
    };
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered cavage signature", async () => {
    const k = keys["rsa-v1_5-sha256"]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      profile: "cavage",
      key: k.privateKey,
      keyId: "k",
      alg: "rsa-v1_5-sha256",
      components: ["(request-target)", "host", "date"],
    });
    const received: HttpMessage = {
      ...message,
      headers: {
        ...message.headers,
        ...headers,
        date: "Wed, 21 Apr 2021 00:00:00 GMT",
      },
    };
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
    });
    expect(result).toMatchObject({
      valid: false,
      profile: "cavage",
      reason: "signature_invalid",
    });
  });

  it("catches a body that does not match the covered Digest", async () => {
    const k = keys["rsa-v1_5-sha256"]!;
    const body = '{"type":"Create"}';
    const message = baseMessage();
    message.headers["digest"] = await createDigest(body);
    const headers = await signMessage(message, {
      profile: "cavage",
      key: k.privateKey,
      keyId: "k",
      alg: "rsa-v1_5-sha256",
      components: ["(request-target)", "host", "digest"],
    });
    const received: HttpMessage = {
      ...message,
      headers: { ...message.headers, ...headers },
    };
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
      body: '{"type":"Undo"}',
    });
    expect(result.reason).toBe("digest_mismatch");
  });

  it("rejects an expired cavage signature", async () => {
    const k = keys["rsa-v1_5-sha256"]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      profile: "cavage",
      key: k.privateKey,
      keyId: "k",
      alg: "rsa-v1_5-sha256",
      components: ["(request-target)", "(expires)", "host"],
      expires: NOW + 60,
    });
    const received: HttpMessage = {
      ...message,
      headers: { ...message.headers, ...headers },
    };
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW + 1000,
      toleranceSeconds: 5,
    });
    expect(result.reason).toBe("signature_expired");
  });

  it("rejects a cavage signature whose expires precedes created", async () => {
    const k = keys["rsa-v1_5-sha256"]!;
    const message = baseMessage();
    const headers = await signMessage(message, {
      profile: "cavage",
      key: k.privateKey,
      keyId: "k",
      alg: "rsa-v1_5-sha256",
      components: ["(request-target)", "(created)", "(expires)", "host"],
      created: NOW,
      expires: NOW - 100,
    });
    const received: HttpMessage = {
      ...message,
      headers: { ...message.headers, ...headers },
    };
    const result = await verifyMessage(received, {
      resolveKey: resolverFor(k.publicKey),
      now: NOW,
    });
    expect(result.reason).toBe("expires_invalid");
  });
});

// --- misc -------------------------------------------------------------------

describe("isSupportedAlgorithm", () => {
  it("accepts allow-listed algorithms and rejects others", () => {
    expect(isSupportedAlgorithm("ed25519")).toBe(true);
    expect(isSupportedAlgorithm("rsa-pss-sha512")).toBe(true);
    expect(isSupportedAlgorithm("hmac-sha256")).toBe(false);
    expect(isSupportedAlgorithm("none")).toBe(false);
  });
});
