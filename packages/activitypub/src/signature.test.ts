import { beforeAll, describe, expect, it } from "vitest";

import {
  buildSigningString,
  digestHeader,
  parseSignatureHeader,
  signRequest,
  verifyInboxSignature,
  type InboxRequest,
  type KeyResolver,
} from "./signature.js";

// ---------------------------------------------------------------------------
// RSA key fixtures (generated once, exported to PEM exactly as Mastodon does)
// ---------------------------------------------------------------------------

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

function toPem(der: ArrayBuffer, label: string): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

let publicKeyPem: string;
let privateKeyPem: string;
let otherPublicKeyPem: string;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(RSA, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  publicKeyPem = toPem(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
    "PUBLIC KEY",
  );
  privateKeyPem = toPem(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    "PRIVATE KEY",
  );
  const other = (await crypto.subtle.generateKey(RSA, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  otherPublicKeyPem = toPem(
    (await crypto.subtle.exportKey("spki", other.publicKey)) as ArrayBuffer,
    "PUBLIC KEY",
  );
});

const KEY_ID = "https://remote.example/users/alice#main-key";
const ACTOR = "https://remote.example/users/alice";

/** Build the verifiable inbound request from a signed delivery. */
async function signedInbox(body: string, now: number): Promise<InboxRequest> {
  const url = "https://example.com/users/bob/inbox";
  const signed = await signRequest(
    url,
    new TextEncoder().encode(body),
    { keyId: KEY_ID, privateKeyPem },
    { now: () => now },
  );
  const headers = new Headers(signed.headers);
  return {
    method: "POST",
    path: "/users/bob/inbox",
    headers,
    body: new TextEncoder().encode(body),
  };
}

const resolver = (pem: string): KeyResolver => {
  return (keyId) =>
    keyId === KEY_ID ? { owner: ACTOR, publicKeyPem: pem } : null;
};

describe("parseSignatureHeader", () => {
  it("parses the quoted key=value pairs", () => {
    const parsed = parseSignatureHeader(
      'keyId="k#main",algorithm="rsa-sha256",headers="(request-target) host",signature="abc=="',
    );
    expect(parsed.keyId).toBe("k#main");
    expect(parsed.algorithm).toBe("rsa-sha256");
    expect(parsed.headers).toBe("(request-target) host");
    expect(parsed.signature).toBe("abc==");
  });
});

describe("buildSigningString", () => {
  it("expands (request-target) and pulls header values", () => {
    const headers = new Headers({ host: "example.com", date: "now" });
    expect(
      buildSigningString(["(request-target)", "host", "date"], {
        method: "POST",
        path: "/inbox",
        headers,
      }),
    ).toBe("(request-target): post /inbox\nhost: example.com\ndate: now");
  });

  it("returns null when a covered header is absent", () => {
    expect(
      buildSigningString(["digest"], {
        method: "POST",
        path: "/x",
        headers: new Headers(),
      }),
    ).toBeNull();
  });
});

describe("verifyInboxSignature", () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const body = JSON.stringify({ type: "Follow", id: "https://remote/1" });

  it("accepts a valid signature and returns the actor", async () => {
    const inbox = await signedInbox(body, now);
    const result = await verifyInboxSignature(inbox, resolver(publicKeyPem), {
      now: () => now,
    });
    expect(result).toEqual({ ok: true, keyId: KEY_ID, actor: ACTOR });
  });

  it("rejects a tampered body (digest mismatch)", async () => {
    const inbox = await signedInbox(body, now);
    const tampered: InboxRequest = {
      ...inbox,
      body: new TextEncoder().encode(body + " "),
    };
    const result = await verifyInboxSignature(
      tampered,
      resolver(publicKeyPem),
      { now: () => now },
    );
    expect(result).toEqual({ ok: false, reason: "digest_mismatch" });
  });

  it("rejects a stale Date outside the skew window", async () => {
    const inbox = await signedInbox(body, now);
    const result = await verifyInboxSignature(inbox, resolver(publicKeyPem), {
      now: () => now + 10 * 60 * 1000,
      clockSkewSeconds: 300,
    });
    expect(result).toEqual({ ok: false, reason: "stale_date" });
  });

  it("rejects the wrong key", async () => {
    const inbox = await signedInbox(body, now);
    const result = await verifyInboxSignature(
      inbox,
      resolver(otherPublicKeyPem),
      { now: () => now },
    );
    expect(result).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("rejects when the key cannot be resolved", async () => {
    const inbox = await signedInbox(body, now);
    const result = await verifyInboxSignature(inbox, () => null, {
      now: () => now,
    });
    expect(result).toEqual({ ok: false, reason: "key_unresolved" });
  });

  it("rejects a missing Signature header", async () => {
    const result = await verifyInboxSignature(
      {
        method: "POST",
        path: "/users/bob/inbox",
        headers: new Headers(),
        body: new TextEncoder().encode(body),
      },
      resolver(publicKeyPem),
    );
    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("rejects when a required header is not covered", async () => {
    // Hand-craft a signature header that omits `digest` from the covered set.
    const inbox = await signedInbox(body, now);
    const sig = inbox.headers
      .get("signature")!
      .replace(
        'headers="(request-target) host date digest content-type"',
        'headers="(request-target) host date"',
      );
    inbox.headers.set("signature", sig);
    const result = await verifyInboxSignature(inbox, resolver(publicKeyPem), {
      now: () => now,
    });
    expect(result).toEqual({ ok: false, reason: "missing_covered_header" });
  });
});

describe("digestHeader", () => {
  it("matches a known SHA-256 of the empty body", async () => {
    expect(await digestHeader(new Uint8Array(0))).toBe(
      "SHA-256=47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    );
  });
});
