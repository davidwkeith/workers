import { env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";

import { createSolidOidc } from "./handler.js";
import { generateSigningJwk } from "./jws.js";
import {
  bytesToBase64url,
  base64urlToBytes,
  sha256Base64url,
  textToBase64url,
} from "./encoding.js";
import { SolidOidcLogEvent } from "./log.js";
import type { SolidOidcConfig, SolidOidcEnv } from "./index.js";

const testEnv = env as unknown as SolidOidcEnv;
const ctx = {} as ExecutionContext;

const ISSUER = "https://id.example";
const CLIENT_ID = "https://app.example/id";
const REDIRECT = "https://app.example/callback";
const WEBID = "https://alice.example/profile#me";

/** A handler wired with a fresh signing key and an auto-approving owner hook. */
async function makeHandler(
  overrides: Partial<SolidOidcConfig> = {},
): Promise<ReturnType<typeof createSolidOidc>> {
  const signingKey = await generateSigningJwk();
  const config: SolidOidcConfig = {
    issuer: ISSUER,
    signingKey,
    audience: ["solid", "https://alice.example"],
    approveAuthorization: async () => ({ webid: WEBID }),
    ...overrides,
  };
  return createSolidOidc(config);
}

/** A PKCE verifier + its S256 challenge. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = bytesToBase64url(crypto.getRandomValues(new Uint8Array(48)));
  return { verifier, challenge: await sha256Base64url(verifier) };
}

/** A signed DPoP proof for `htm htu`, plus the key's RFC 7638 jkt. */
async function dpopProof(
  htm: string,
  htu: string,
): Promise<{ proof: string; jkt: string }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as {
    crv: string;
    x: string;
    y: string;
  };
  const jwk = { kty: "EC", crv: pub.crv, x: pub.x, y: pub.y };
  const header = { typ: "dpop+jwt", alg: "ES256", jwk };
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: bytesToBase64url(crypto.getRandomValues(new Uint8Array(16))),
  };
  const signingInput = `${textToBase64url(
    JSON.stringify(header),
  )}.${textToBase64url(JSON.stringify(payload))}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  const proof = `${signingInput}.${bytesToBase64url(sig)}`;
  // jkt = base64url(SHA-256(canonical {crv,kty,x,y}))
  const jkt = await sha256Base64url(
    JSON.stringify({ crv: pub.crv, kty: "EC", x: pub.x, y: pub.y }),
  );
  return { proof, jkt };
}

/** Drive authorize → code. */
async function getCode(
  handler: ReturnType<typeof createSolidOidc>,
  challenge: string,
): Promise<string> {
  const url = new URL(`${ISSUER}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT);
  url.searchParams.set("scope", "openid webid");
  url.searchParams.set("state", "xyz");
  url.searchParams.set("nonce", "n-1");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  const res = await handler(new Request(url.toString()), testEnv, ctx);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(location.searchParams.get("state")).toBe("xyz");
  return location.searchParams.get("code")!;
}

function decodeJwt(jwt: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [h, p] = jwt.split(".");
  return {
    header: JSON.parse(new TextDecoder().decode(base64urlToBytes(h!))),
    payload: JSON.parse(new TextDecoder().decode(base64urlToBytes(p!))),
  };
}

async function resetDb(): Promise<void> {
  await testEnv.AUTH_DB.exec("DROP TABLE IF EXISTS solid_oidc_codes");
}

describe("createSolidOidc — discovery + JWKS", () => {
  beforeEach(resetDb);

  it("serves an OIDC discovery document with the Solid-OIDC marker", async () => {
    const handler = await makeHandler();
    const res = await handler(
      new Request(`${ISSUER}/.well-known/openid-configuration`),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(doc.token_endpoint).toBe(`${ISSUER}/token`);
    expect(doc.jwks_uri).toBe(`${ISSUER}/jwks`);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.dpop_signing_alg_values_supported).toContain("ES256");
    expect(doc.solid_oidc_supported).toBe(
      "https://solidproject.org/TR/solid-oidc",
    );
  });

  it("serves JWKS with the public key only (no private scalar)", async () => {
    const handler = await makeHandler();
    const res = await handler(new Request(`${ISSUER}/jwks`), testEnv, ctx);
    expect(res.status).toBe(200);
    const jwks = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", use: "sig" });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });
});

describe("createSolidOidc — authorization-code + PKCE + DPoP flow", () => {
  beforeEach(resetDb);

  it("issues a DPoP-bound access token whose claims a Solid RS accepts", async () => {
    const handler = await makeHandler();
    const { verifier, challenge } = await pkce();
    const code = await getCode(handler, challenge);
    const { proof, jkt } = await dpopProof("POST", `${ISSUER}/token`);

    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          DPoP: proof,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
      id_token: string;
      scope: string;
    };
    expect(body.token_type).toBe("DPoP");
    expect(body.scope).toBe("openid webid");

    // Access-token claims the pod validates.
    const { header, payload } = decodeJwt(body.access_token);
    expect(header).toMatchObject({ alg: "ES256", typ: "at+jwt" });
    expect(payload.iss).toBe(ISSUER);
    expect(payload.webid).toBe(WEBID);
    expect(payload.aud).toEqual(["solid", "https://alice.example"]);
    expect(payload.cnf).toEqual({ jkt }); // bound to the DPoP key
    expect(payload.client_id).toBe(CLIENT_ID);

    // ID token carries the echoed nonce.
    const idClaims = decodeJwt(body.id_token).payload;
    expect(idClaims.nonce).toBe("n-1");
    expect(idClaims.webid).toBe(WEBID);

    // The access token verifies against the published JWKS.
    const jwks = (await (
      await handler(new Request(`${ISSUER}/jwks`), testEnv, ctx)
    ).json()) as { keys: { x: string; y: string }[] };
    const pub = jwks.keys[0]!;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: pub.x, y: pub.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const [h, p, s] = body.access_token.split(".");
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64urlToBytes(s!),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it("rejects a replayed (already-used) code", async () => {
    const handler = await makeHandler();
    const { verifier, challenge } = await pkce();
    const code = await getCode(handler, challenge);
    const exchange = async () => {
      const { proof } = await dpopProof("POST", `${ISSUER}/token`);
      return handler(
        new Request(`${ISSUER}/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            DPoP: proof,
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT,
            client_id: CLIENT_ID,
            code_verifier: verifier,
          }),
        }),
        testEnv,
        ctx,
      );
    };
    expect((await exchange()).status).toBe(200);
    const second = await exchange();
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  it("requires a DPoP proof at the token endpoint", async () => {
    const handler = await makeHandler();
    const { verifier, challenge } = await pkce();
    const code = await getCode(handler, challenge);
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_dpop_proof",
    );
  });

  it("rejects a wrong PKCE verifier", async () => {
    const handler = await makeHandler();
    const { challenge } = await pkce();
    const code = await getCode(handler, challenge);
    const { proof } = await dpopProof("POST", `${ISSUER}/token`);
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          DPoP: proof,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier-xx",
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  it("lets the approval hook take over with its own Response (consent screen)", async () => {
    const handler = await makeHandler({
      approveAuthorization: async () =>
        new Response("login", { status: 200, headers: { "x-consent": "1" } }),
    });
    const { challenge } = await pkce();
    const url = new URL(`${ISSUER}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handler(new Request(url.toString()), testEnv, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-consent")).toBe("1");
  });

  it("400s an authorize request missing PKCE (via redirect error)", async () => {
    const handler = await makeHandler();
    const url = new URL(`${ISSUER}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT);
    const res = await handler(new Request(url.toString()), testEnv, ctx);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
  });

  it("400s directly when redirect_uri is not an absolute URL", async () => {
    const handler = await makeHandler();
    const url = new URL(`${ISSUER}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", "notaurl");
    const res = await handler(new Request(url.toString()), testEnv, ctx);
    expect(res.status).toBe(400);
  });

  it("rejects an oversized token request body as invalid_request", async () => {
    const handler = await makeHandler();
    const { verifier, challenge } = await pkce();
    const code = await getCode(handler, challenge);
    const { proof } = await dpopProof("POST", `${ISSUER}/token`);
    // A full, otherwise-valid request (would succeed with 200 absent the
    // cap) plus an oversized extra field, so the cap is what's under test —
    // not a coincidental "missing required field" 400.
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          DPoP: proof,
        },
        body: `grant_type=authorization_code&code=${encodeURIComponent(
          code,
        )}&redirect_uri=${encodeURIComponent(
          REDIRECT,
        )}&client_id=${encodeURIComponent(
          CLIENT_ID,
        )}&code_verifier=${encodeURIComponent(
          verifier,
        )}&padding=${"x".repeat(16 * 1024)}`,
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });
});

describe("createSolidOidc — logger/metrics on token-endpoint rejections", () => {
  beforeEach(resetDb);

  /** A logger + metrics spy pair, plus the config overrides to wire them in. */
  function spyLogging(): {
    logged: Array<["warn" | "error", string, unknown]>;
    counted: Array<[string, unknown]>;
    overrides: Partial<SolidOidcConfig>;
  } {
    const logged: Array<["warn" | "error", string, unknown]> = [];
    const counted: Array<[string, unknown]> = [];
    return {
      logged,
      counted,
      overrides: {
        logger: {
          debug: () => {},
          info: () => {},
          warn: (event, fields) => logged.push(["warn", event, fields]),
          error: (event, fields) => logged.push(["error", event, fields]),
        },
        metrics: {
          count: (event, fields) => counted.push([event, fields]),
          observe: () => {},
        },
      },
    };
  }

  it("logs+counts a warn event when the DPoP proof is missing", async () => {
    const { logged, counted, overrides } = spyLogging();
    const handler = await makeHandler(overrides);
    const { verifier, challenge } = await pkce();
    const code = await getCode(handler, challenge);
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(logged).toContainEqual([
      "warn",
      SolidOidcLogEvent.DpopRejected,
      { reason: "missing" },
    ]);
    expect(counted).toContainEqual([
      SolidOidcLogEvent.DpopRejected,
      { reason: "missing" },
    ]);
  });

  it("logs a warn event when the DPoP proof is invalid", async () => {
    const { logged, overrides } = spyLogging();
    const handler = await makeHandler(overrides);
    const { verifier, challenge } = await pkce();
    const code = await getCode(handler, challenge);
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          DPoP: "not-a-valid-proof",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(
      logged.some(
        ([level, event]) =>
          level === "warn" && event === SolidOidcLogEvent.DpopRejected,
      ),
    ).toBe(true);
  });

  it("logs a warn event when the code is invalid/replayed", async () => {
    const { logged, overrides } = spyLogging();
    const handler = await makeHandler(overrides);
    const { proof } = await dpopProof("POST", `${ISSUER}/token`);
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          DPoP: proof,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "no-such-code",
          redirect_uri: REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: "whatever-whatever-whatever-whatever-whatever12",
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(logged).toContainEqual([
      "warn",
      SolidOidcLogEvent.InvalidGrant,
      { reason: "code_invalid_used_or_expired" },
    ]);
  });

  it("logs a warn event on client_id/redirect_uri mismatch", async () => {
    const { logged, overrides } = spyLogging();
    const handler = await makeHandler(overrides);
    const { verifier, challenge } = await pkce();
    const code = await getCode(handler, challenge);
    const { proof } = await dpopProof("POST", `${ISSUER}/token`);
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          DPoP: proof,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://not-the-registered-client.example/callback",
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(logged).toContainEqual([
      "warn",
      SolidOidcLogEvent.InvalidGrant,
      { reason: "client_or_redirect_mismatch" },
    ]);
  });

  it("logs a warn event on PKCE mismatch", async () => {
    const { logged, overrides } = spyLogging();
    const handler = await makeHandler(overrides);
    const { challenge } = await pkce();
    const code = await getCode(handler, challenge);
    const { proof } = await dpopProof("POST", `${ISSUER}/token`);
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          DPoP: proof,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier-xx",
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(logged).toContainEqual([
      "warn",
      SolidOidcLogEvent.PkceMismatch,
      undefined,
    ]);
  });

  it("stays silent (noop) when no logger/metrics is configured", async () => {
    // No overrides — default config resolves to noopLogger/noopMetrics, so
    // this must not throw even though every rejection path calls them.
    const handler = await makeHandler();
    const { verifier, challenge } = await pkce();
    const code = await getCode(handler, challenge);
    const res = await handler(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: CLIENT_ID,
          code_verifier: verifier,
        }),
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("createSolidOidc — performance (CodeStore memoization)", () => {
  beforeEach(resetDb);

  it("does not rebuild CodeStore's D1 schema check on every /authorize request", async () => {
    let schemaCheckCalls = 0;

    // Wrap the D1Database to track CREATE TABLE calls
    const wrappedDb: typeof testEnv.AUTH_DB = {
      prepare: (sql: string) => {
        if (sql.includes("CREATE TABLE IF NOT EXISTS solid_oidc_codes")) {
          schemaCheckCalls += 1;
        }
        return testEnv.AUTH_DB.prepare(sql);
      },
      exec: testEnv.AUTH_DB.exec.bind(testEnv.AUTH_DB),
      batch: testEnv.AUTH_DB.batch.bind(testEnv.AUTH_DB),
      dump: testEnv.AUTH_DB.dump.bind(testEnv.AUTH_DB),
      withSession: testEnv.AUTH_DB.withSession.bind(testEnv.AUTH_DB),
    };

    const handler = await makeHandler();
    const { challenge } = await pkce();

    // Create an authorize request helper
    const makeAuthorizeRequest = () => {
      const url = new URL(`${ISSUER}/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", CLIENT_ID);
      url.searchParams.set("redirect_uri", REDIRECT);
      url.searchParams.set("scope", "openid webid");
      url.searchParams.set("state", "xyz");
      url.searchParams.set("nonce", "n-1");
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return new Request(url.toString());
    };

    // Make multiple authorize requests
    await handler(
      makeAuthorizeRequest(),
      { ...testEnv, AUTH_DB: wrappedDb },
      ctx,
    );
    await handler(
      makeAuthorizeRequest(),
      { ...testEnv, AUTH_DB: wrappedDb },
      ctx,
    );

    // Schema check should only happen once, not on every request
    expect(schemaCheckCalls).toBe(1);
  });
});
