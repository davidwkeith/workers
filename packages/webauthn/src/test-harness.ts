/**
 * Test-only Worker entrypoint and fixtures.
 *
 * Exports the {@link WebAuthnObject} Durable Object class so the vitest pool can
 * bind it, a default `fetch` so the Worker module is valid, and a small
 * authenticator simulator (a CBOR encoder, COSE-key builder, authenticator-data
 * assembler, and DER signature wrapper) that the colocated tests use to mint
 * valid registration and authentication ceremonies. Excluded from the published
 * build and from coverage; not part of the package's public surface.
 */

import { createWebAuthn } from "./handler.js";
import type { WebAuthnEnv } from "./config.js";
import { bytesToBase64url, sha256, utf8ToBytes } from "./encoding.js";

export { WebAuthnObject } from "./rp.js";

export default {
  fetch(): Response {
    // Tests call `createWebAuthn` directly with the test bindings; this default
    // exists only so the Worker module is valid.
    void createWebAuthn;
    return new Response("ok");
  },
} satisfies ExportedHandler<WebAuthnEnv>;

// ---------------------------------------------------------------------------
// Minimal CBOR encoder (the inverse of the subset `cbor.ts` decodes)
// ---------------------------------------------------------------------------

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Encode the `major`-type header for an argument `n`. */
function cborHead(major: number, n: number): Uint8Array {
  const m = major << 5;
  if (n < 24) return new Uint8Array([m | n]);
  if (n < 0x100) return new Uint8Array([m | 24, n]);
  if (n < 0x10000) return new Uint8Array([m | 25, n >> 8, n & 0xff]);
  return new Uint8Array([
    m | 26,
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]);
}

/** A CBOR value the test encoder accepts. */
export type CborInput =
  | number
  | string
  | Uint8Array
  | CborInput[]
  | Map<number | string, CborInput>;

/** Encode the WebAuthn CBOR subset (ints, byte/text strings, arrays, maps). */
export function encodeCbor(value: CborInput): Uint8Array {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -value - 1);
  }
  if (typeof value === "string") {
    const bytes = utf8ToBytes(value);
    return concatBytes([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return concatBytes([cborHead(2, value.length), value]);
  }
  if (Array.isArray(value)) {
    return concatBytes([cborHead(4, value.length), ...value.map(encodeCbor)]);
  }
  const entries = [...value.entries()];
  const parts = [cborHead(5, entries.length)];
  for (const [k, v] of entries) {
    parts.push(encodeCbor(k), encodeCbor(v));
  }
  return concatBytes(parts);
}

// ---------------------------------------------------------------------------
// Authenticator simulator
// ---------------------------------------------------------------------------

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** A simulated authenticator credential (ES256). */
export interface TestCredential {
  readonly privateKey: CryptoKey;
  readonly credentialId: Uint8Array;
  readonly credentialIdB64: string;
  /** The credential public key as a COSE_Key map. */
  readonly coseKey: Map<number, CborInput>;
}

/** Create a fresh ES256 credential with a random credential id. */
export async function createTestCredential(): Promise<TestCredential> {
  const pair = (await crypto.subtle.generateKey(ECDSA_P256, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;
  const x = base64urlDecode(jwk.x!);
  const y = base64urlDecode(jwk.y!);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const coseKey = new Map<number, CborInput>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, x],
    [-3, y],
  ]);
  return {
    privateKey: pair.privateKey,
    credentialId,
    credentialIdB64: bytesToBase64url(credentialId),
    coseKey,
  };
}

function base64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Authenticator-data flag bits. */
export interface FlagOptions {
  readonly up?: boolean;
  readonly uv?: boolean;
}

/** Build authenticator data, optionally with attested credential data. */
export async function buildAuthData(options: {
  rpId: string;
  signCount: number;
  flags?: FlagOptions;
  credential?: TestCredential;
}): Promise<Uint8Array> {
  const rpIdHash = await sha256(utf8ToBytes(options.rpId));
  const up = options.flags?.up ?? true;
  const uv = options.flags?.uv ?? true;
  const at = options.credential !== undefined;
  let flags = 0;
  if (up) flags |= 0x01;
  if (uv) flags |= 0x04;
  if (at) flags |= 0x40;

  const header = new Uint8Array(37);
  header.set(rpIdHash, 0);
  header[32] = flags;
  new DataView(header.buffer).setUint32(33, options.signCount);
  if (!options.credential) return header;

  const aaguid = new Uint8Array(16); // all-zero AAGUID
  const credIdLen = new Uint8Array(2);
  new DataView(credIdLen.buffer).setUint16(
    0,
    options.credential.credentialId.length,
  );
  const coseBytes = encodeCbor(options.credential.coseKey);
  return concatBytes([
    header,
    aaguid,
    credIdLen,
    options.credential.credentialId,
    coseBytes,
  ]);
}

/** Build a `clientDataJSON` byte string for a ceremony. */
export function buildClientDataJSON(options: {
  type: "webauthn.create" | "webauthn.get";
  challenge: string;
  origin: string;
}): Uint8Array {
  return utf8ToBytes(
    JSON.stringify({
      type: options.type,
      challenge: options.challenge,
      origin: options.origin,
      crossOrigin: false,
    }),
  );
}

/** Wrap authData + a `none` attestation statement into an attestation object. */
export function buildAttestationObject(authData: Uint8Array): Uint8Array {
  return encodeCbor(
    new Map<string, CborInput>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );
}

/** Sign assertion data and return a DER-encoded ECDSA signature (WebAuthn form). */
export async function signAssertion(
  credential: TestCredential,
  authData: Uint8Array,
  clientDataJSON: Uint8Array,
): Promise<Uint8Array> {
  const clientDataHash = await sha256(clientDataJSON);
  const signed = concatBytes([authData, clientDataHash]);
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      ECDSA_SIGN,
      credential.privateKey,
      signed as BufferSource,
    ),
  );
  return rawToDerEcdsaSignature(raw);
}

/** Convert a raw `r‖s` ECDSA signature (P-256) to ASN.1 DER. */
export function rawToDerEcdsaSignature(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const toDerInteger = (bytes: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.subarray(i);
    if ((v[0]! & 0x80) !== 0) v = concatBytes([new Uint8Array([0]), v]);
    return concatBytes([new Uint8Array([0x02, v.length]), v]);
  };
  const r = toDerInteger(raw.subarray(0, half));
  const s = toDerInteger(raw.subarray(half));
  const body = concatBytes([r, s]);
  return concatBytes([new Uint8Array([0x30, body.length]), body]);
}
