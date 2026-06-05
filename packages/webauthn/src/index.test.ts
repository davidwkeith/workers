import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { createWebAuthn, type WebAuthnConfig, type WebAuthnEnv } from "./index";
import { bytesToBase64url } from "./encoding";
import {
  buildAttestationObject,
  buildAuthData,
  buildClientDataJSON,
  createTestCredential,
  signAssertion,
  type TestCredential,
} from "./test-harness";

const testEnv = env as unknown as WebAuthnEnv;

/** A relying party whose rpId/origin are unique per test (fresh DO + state). */
function rp(suffix: string, overrides?: Partial<WebAuthnConfig>) {
  const rpId = `${suffix}.example`;
  const origin = `https://${rpId}`;
  const config: WebAuthnConfig = {
    rpId,
    rpName: "Test RP",
    origin,
    ...overrides,
  };
  return { rpId, origin, handler: createWebAuthn(config) };
}

async function post(
  handler: (
    r: Request,
    e: WebAuthnEnv,
    c: ExecutionContext,
  ) => Promise<Response>,
  origin: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const request = new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handler(request, testEnv, {} as ExecutionContext);
}

/** Run a registration ceremony and return the stored credential + ids. */
async function doRegister(
  handler: (
    r: Request,
    e: WebAuthnEnv,
    c: ExecutionContext,
  ) => Promise<Response>,
  rpId: string,
  origin: string,
  credential: TestCredential,
): Promise<{ challenge: string; credentialId: string }> {
  const optionsResponse = await post(handler, origin, "/register/options", {
    user: { id: "dXNlci0x", name: "alice", displayName: "Alice" },
  });
  const options = (await optionsResponse.json()) as { challenge: string };

  const clientDataJSON = buildClientDataJSON({
    type: "webauthn.create",
    challenge: options.challenge,
    origin,
  });
  const authData = await buildAuthData({ rpId, signCount: 0, credential });
  const verifyResponse = await post(handler, origin, "/register/verify", {
    id: credential.credentialIdB64,
    rawId: credential.credentialIdB64,
    type: "public-key",
    response: {
      clientDataJSON: bytesToBase64url(clientDataJSON),
      attestationObject: bytesToBase64url(buildAttestationObject(authData)),
      transports: ["internal"],
    },
  });
  expect(verifyResponse.status).toBe(200);
  const verified = (await verifyResponse.json()) as { credentialId: string };
  return { challenge: options.challenge, credentialId: verified.credentialId };
}

/** Run an authentication ceremony with a given signCount. */
async function doAuthenticate(
  handler: (
    r: Request,
    e: WebAuthnEnv,
    c: ExecutionContext,
  ) => Promise<Response>,
  rpId: string,
  origin: string,
  credential: TestCredential,
  signCount: number,
): Promise<Response> {
  const optionsResponse = await post(
    handler,
    origin,
    "/authenticate/options",
    {},
  );
  const options = (await optionsResponse.json()) as { challenge: string };

  const clientDataJSON = buildClientDataJSON({
    type: "webauthn.get",
    challenge: options.challenge,
    origin,
  });
  const authData = await buildAuthData({ rpId, signCount });
  const signature = await signAssertion(credential, authData, clientDataJSON);
  return post(handler, origin, "/authenticate/verify", {
    id: credential.credentialIdB64,
    type: "public-key",
    response: {
      clientDataJSON: bytesToBase64url(clientDataJSON),
      authenticatorData: bytesToBase64url(authData),
      signature: bytesToBase64url(signature),
    },
  });
}

describe("@dwk/webauthn handler", () => {
  it("completes a full registration + authentication round trip", async () => {
    const { rpId, origin, handler } = rp("roundtrip");
    const credential = await createTestCredential();

    const { credentialId } = await doRegister(
      handler,
      rpId,
      origin,
      credential,
    );
    expect(credentialId).toBe(credential.credentialIdB64);

    const authResponse = await doAuthenticate(
      handler,
      rpId,
      origin,
      credential,
      1,
    );
    expect(authResponse.status).toBe(200);
    expect(await authResponse.json()).toMatchObject({
      verified: true,
      credentialId: credential.credentialIdB64,
    });
  });

  it("issues registration options with the configured rp and algorithms", async () => {
    const { handler, origin } = rp("options");
    const response = await post(handler, origin, "/register/options", {});
    expect(response.status).toBe(200);
    const options = (await response.json()) as Record<string, unknown>;
    expect(options.rp).toMatchObject({
      id: "options.example",
      name: "Test RP",
    });
    expect(options.challenge).toEqual(expect.any(String));
    expect(options.pubKeyCredParams).toEqual([
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ]);
    expect(options.attestation).toBe("none");
  });

  it("treats a challenge as single-use (no replay)", async () => {
    const { rpId, origin, handler } = rp("replay");
    const credential = await createTestCredential();
    const optionsResponse = await post(
      handler,
      origin,
      "/register/options",
      {},
    );
    const { challenge } = (await optionsResponse.json()) as {
      challenge: string;
    };

    const clientDataJSON = buildClientDataJSON({
      type: "webauthn.create",
      challenge,
      origin,
    });
    const authData = await buildAuthData({ rpId, signCount: 0, credential });
    const body = {
      id: credential.credentialIdB64,
      type: "public-key",
      response: {
        clientDataJSON: bytesToBase64url(clientDataJSON),
        attestationObject: bytesToBase64url(buildAttestationObject(authData)),
      },
    };

    const first = await post(handler, origin, "/register/verify", body);
    expect(first.status).toBe(200);
    const second = await post(handler, origin, "/register/verify", body);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: "challenge_mismatch" });
  });

  it("rejects authentication for an unknown credential", async () => {
    const { rpId, origin, handler } = rp("unknown");
    const credential = await createTestCredential();
    // Authenticate without ever registering.
    const response = await doAuthenticate(handler, rpId, origin, credential, 1);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "no_credential" });
  });

  it("rejects a counter regression on a second assertion", async () => {
    const { rpId, origin, handler } = rp("counter");
    const credential = await createTestCredential();
    await doRegister(handler, rpId, origin, credential);

    const first = await doAuthenticate(handler, rpId, origin, credential, 10);
    expect(first.status).toBe(200);
    // Replaying an assertion with a non-increasing counter is rejected.
    const second = await doAuthenticate(handler, rpId, origin, credential, 10);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: "counter_regression" });
  });

  it("emits ceremony outcomes on the injected logger and strips internal headers", async () => {
    const events: string[] = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn((e: string) => events.push(e)),
      warn: vi.fn((e: string) => events.push(e)),
      error: vi.fn(),
    };
    const { handler, origin } = rp("logged", { logger });
    const response = await post(handler, origin, "/register/options", {});
    expect(response.headers.get("x-webauthn-event")).toBeNull();
    expect(response.headers.get("x-webauthn-reason")).toBeNull();
    expect(events).toContain("webauthn.register.options");
  });

  it("returns 404 for unknown paths and 405 for non-POST", async () => {
    const { handler, origin } = rp("routing");
    const notFound = await post(handler, origin, "/nope", {});
    expect(notFound.status).toBe(404);

    const get = new Request(`${origin}/register/options`, { method: "GET" });
    const method = await handler(get, testEnv, {} as ExecutionContext);
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");
  });

  it("fails loudly when the Durable Object binding is missing", async () => {
    const { handler, origin } = rp("nobinding");
    const request = new Request(`${origin}/register/options`, {
      method: "POST",
      body: "{}",
    });
    await expect(
      handler(request, {} as WebAuthnEnv, {} as ExecutionContext),
    ).rejects.toThrow(/missing required Durable Object binding/);
  });
});
