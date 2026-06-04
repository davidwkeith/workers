import { env } from "cloudflare:test";
import { describe, expect, it, beforeAll } from "vitest";

import {
  addProof,
  buildDidDocument,
  createVc,
  decodeBitstring,
  encodeEd25519Multikey,
  getBit,
  importSigner,
  verifyProof,
  type DidResolver,
  type JsonObject,
  type SecuredDocument,
  type VcConfig,
  type VcEnv,
  type VerificationMethod,
} from "./index";

const BASE = "https://example.com";
const DID = "did:web:example.com";
const VM_ID = `${DID}#key-0`;

let privateJwk: JsonWebKey;
let publicKeyMultibase: string;
let resolveDid: DidResolver;
let testEnv: VcEnv;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  )) as JsonWebKey;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  publicKeyMultibase = encodeEd25519Multikey(raw);
  const vm: VerificationMethod = {
    id: VM_ID,
    type: "Multikey",
    publicKeyMultibase,
  };
  resolveDid = () => vm;
  testEnv = {
    VC_SIGNING_KEY: JSON.stringify(privateJwk),
    VC_STATUS_DB: (env as unknown as { VC_STATUS_DB: D1Database }).VC_STATUS_DB,
  };
});

function makeHandler(overrides: Partial<VcConfig> = {}) {
  return createVc({
    baseUrl: BASE,
    resolveDid,
    status: { enabled: true },
    ...overrides,
  });
}

const ctx = {} as ExecutionContext;

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const sampleCredential = (): JsonObject => ({
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  type: ["VerifiableCredential"],
  issuer: DID,
  validFrom: "2026-01-01T00:00:00Z",
  credentialSubject: { id: "did:web:alice.example", name: "Alice" },
});

describe("createVc — issuance", () => {
  it("issues a signed credential with a status entry", async () => {
    const handler = makeHandler();
    const res = await handler(
      post("/credentials/issue", { credential: sampleCredential() }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    const { verifiableCredential } = (await res.json()) as {
      verifiableCredential: SecuredDocument;
    };
    expect(verifiableCredential.proof.cryptosuite).toBe("eddsa-jcs-2022");
    expect(verifiableCredential.proof.verificationMethod).toBe(VM_ID);
    expect(verifiableCredential.credentialSubject).toBeDefined();
    const status = verifiableCredential.credentialStatus as JsonObject;
    expect(status.type).toBe("BitstringStatusListEntry");

    // The issued credential verifies independently.
    const result = await verifyProof(verifiableCredential, {
      resolveVerificationMethod: resolveDid,
    });
    expect(result.verified).toBe(true);
  });

  it("rejects a structurally invalid credential", async () => {
    const handler = makeHandler();
    const res = await handler(
      post("/credentials/issue", { credential: { type: ["Foo"] } }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("honors the authorize hook", async () => {
    const handler = makeHandler({ authorize: () => false });
    const res = await handler(
      post("/credentials/issue", { credential: sampleCredential() }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(401);
  });
});

describe("createVc — verify + revocation lifecycle", () => {
  it("verifies, then fails after the credential is revoked", async () => {
    const handler = makeHandler();

    // 1. Issue.
    const issueRes = await handler(
      post("/credentials/issue", { credential: sampleCredential() }),
      testEnv,
      ctx,
    );
    const { verifiableCredential } = (await issueRes.json()) as {
      verifiableCredential: JsonObject;
    };

    // 2. Verify — valid.
    const verifyOk = await handler(
      post("/credentials/verify", { verifiableCredential }),
      testEnv,
      ctx,
    );
    expect(((await verifyOk.json()) as { verified: boolean }).verified).toBe(
      true,
    );

    // 3. Revoke via the issued credential's status entry.
    const revokeRes = await handler(
      post("/credentials/status", { credential: verifiableCredential }),
      testEnv,
      ctx,
    );
    expect(revokeRes.status).toBe(200);

    // 4. Verify — now rejected as revoked.
    const verifyBad = await handler(
      post("/credentials/verify", { verifiableCredential }),
      testEnv,
      ctx,
    );
    const bad = (await verifyBad.json()) as {
      verified: boolean;
      errors: string[];
    };
    expect(bad.verified).toBe(false);
    expect(bad.errors).toContain("credential is revoked");
  });

  it("serves a signed status list reflecting the revocation", async () => {
    const handler = makeHandler();
    const issueRes = await handler(
      post("/credentials/issue", { credential: sampleCredential() }),
      testEnv,
      ctx,
    );
    const { verifiableCredential } = (await issueRes.json()) as {
      verifiableCredential: JsonObject;
    };
    const entry = verifiableCredential.credentialStatus as JsonObject;
    const index = Number(entry.statusListIndex);

    await handler(
      post("/credentials/status", { credential: verifiableCredential }),
      testEnv,
      ctx,
    );

    const listRes = await handler(
      new Request(`${BASE}/credentials/status-lists/revocation`),
      testEnv,
      ctx,
    );
    expect(listRes.status).toBe(200);
    const listCred = (await listRes.json()) as SecuredDocument;
    expect(listCred.type).toContain("BitstringStatusListCredential");

    // The list credential is itself signed and verifiable.
    const proofResult = await verifyProof(listCred, {
      resolveVerificationMethod: resolveDid,
    });
    expect(proofResult.verified).toBe(true);

    const subject = listCred.credentialSubject as JsonObject;
    const bits = await decodeBitstring(subject.encodedList as string);
    expect(getBit(bits, index)).toBe(true);
  });
});

describe("createVc — verify status SSRF guard", () => {
  it("does not fetch a non-https foreign status list, warns instead", async () => {
    const handler = makeHandler();
    const signer = await importSigner(privateJwk);
    // A credential whose status list points at an internal http URL.
    const credential: JsonObject = {
      ...sampleCredential(),
      credentialStatus: {
        type: "BitstringStatusListEntry",
        statusPurpose: "revocation",
        statusListIndex: "0",
        statusListCredential: "http://169.254.169.254/list",
      },
    };
    const signed = await addProof(credential, signer, {
      verificationMethod: VM_ID,
    });

    const res = await handler(
      post("/credentials/verify", { verifiableCredential: signed }),
      testEnv,
      ctx,
    );
    const body = (await res.json()) as {
      verified: boolean;
      warnings: string[];
    };
    // The proof is valid and the list was never fetched, so the credential is
    // not rejected — but the unchecked status surfaces as a warning.
    expect(body.verified).toBe(true);
    expect(body.warnings).toContain("status list URL must use https");
  });
});

describe("createVc — routing", () => {
  it("returns 404 for an unknown path", async () => {
    const handler = makeHandler();
    const res = await handler(new Request(`${BASE}/nope`), testEnv, ctx);
    expect(res.status).toBe(404);
  });

  it("returns 405 for the wrong method", async () => {
    const handler = makeHandler();
    const res = await handler(
      new Request(`${BASE}/credentials/issue`),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("404s the status endpoints when status is disabled", async () => {
    const handler = makeHandler({ status: { enabled: false } });
    const res = await handler(
      post("/credentials/status", { statusListIndex: 1 }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(404);
  });
});

describe("buildDidDocument integration", () => {
  it("publishes the issuer's verification method", () => {
    const doc = buildDidDocument({
      did: DID,
      verificationMethods: [{ id: "#key-0", publicKeyMultibase }],
    });
    expect(doc.id).toBe(DID);
    expect(doc.assertionMethod).toEqual([VM_ID]);
  });
});
