import { env } from "cloudflare:test";
import { verifyDpopProof } from "@dwk/dpop";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createIndieAuth,
  createIndieAuthStore,
  verifyAccessToken,
  type AuthorizationApproval,
  type AuthorizationRequest,
  type IndieAuthConfig,
  type IndieAuthEnv,
} from "./index";

const harness = env as unknown as IndieAuthEnv;

const BASE = "https://example.com";
const CLIENT_ID = "https://app.example.org/";
const REDIRECT_URI = "https://app.example.org/callback";
const ME = "https://alice.example.com/";

// A real, fixed PKCE verifier/challenge pair (S256). The challenge is
// base64url(SHA-256(verifier)).
const CODE_VERIFIER =
  "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-dBjftJeZ4CVP-mB92K27";

async function s256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// --- DPoP proof helpers (real ES256 signatures, no mocking) ----------------

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface DpopKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

async function makeDpopKey(): Promise<DpopKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;
  // Strip private members from the exported JWK so it is public-only.
  delete publicJwk.d;
  return { privateKey: pair.privateKey, publicJwk };
}

async function makeProof(
  key: DpopKey,
  htm: string,
  htu: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk };
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
    ...extra,
  };
  const headerSeg = bytesToBase64url(
    new TextEncoder().encode(JSON.stringify(header)),
  );
  const payloadSeg = bytesToBase64url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${bytesToBase64url(signature)}`;
}

// --- Config / handler builders ---------------------------------------------

function baseConfig(
  approve: (
    req: AuthorizationRequest,
  ) =>
    | Promise<AuthorizationApproval | Response>
    | AuthorizationApproval
    | Response,
): IndieAuthConfig {
  return {
    baseUrl: BASE,
    scopesSupported: ["create", "update", "media"],
    approveAuthorization: async (req) => approve(req),
  };
}

/** Auto-approving handler granting `me` and the requested scopes. */
function autoApproveHandler(scopes?: readonly string[]) {
  return createIndieAuth(
    baseConfig(() => ({
      me: ME,
      ...(scopes ? { scopes } : {}),
      profile: { name: "Alice" },
    })),
  );
}

async function authorizeUrl(challenge: string, scope = "create update") {
  const url = new URL(`${BASE}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", "xyz123");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", scope);
  url.searchParams.set("me", ME);
  return url.toString();
}

const ctx = {} as ExecutionContext;

beforeEach(async () => {
  await createIndieAuthStore(harness).init();
});

describe("@dwk/indieauth metadata", () => {
  it("serves a discoverable metadata document", async () => {
    const handler = autoApproveHandler();
    const res = await handler(
      new Request(`${BASE}/.well-known/oauth-authorization-server`),
      harness,
      ctx,
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(BASE);
    expect(meta.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(meta.token_endpoint).toBe(`${BASE}/token`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.response_types_supported).toEqual(["code"]);
    expect(meta.grant_types_supported).toEqual(["authorization_code"]);
    expect(meta.scopes_supported).toEqual(["create", "update", "media"]);
    expect(meta.dpop_signing_alg_values_supported).toContain("ES256");
  });
});

describe("@dwk/indieauth authorization-code + PKCE + DPoP flow", () => {
  it("runs end to end and issues a DPoP-bound access token", async () => {
    const challenge = await s256(CODE_VERIFIER);
    const handler = autoApproveHandler();

    // 1. Authorization request → redirect with code.
    const authRes = await handler(
      new Request(await authorizeUrl(challenge), { redirect: "manual" }),
      harness,
      ctx,
    );
    expect(authRes.status).toBe(302);
    const location = new URL(authRes.headers.get("location")!);
    expect(location.searchParams.get("state")).toBe("xyz123");
    expect(location.searchParams.get("iss")).toBe(BASE);
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    // 2. Token request with a DPoP proof bound to the token endpoint.
    const key = await makeDpopKey();
    const proof = await makeProof(key, "POST", `${BASE}/token`);
    const tokenRes = await handler(
      new Request(`${BASE}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          DPoP: proof,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: CODE_VERIFIER,
        }),
      }),
      harness,
      ctx,
    );
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as Record<string, unknown>;
    expect(body.token_type).toBe("DPoP");
    expect(body.me).toBe(ME);
    expect(body.scope).toBe("create update");
    expect(body.expires_in).toBe(3600);
    expect((body.profile as { name: string }).name).toBe("Alice");
    const accessToken = body.access_token as string;

    // 3. The token verifies and carries the DPoP key thumbprint as cnf.jkt.
    const verified = await verifyAccessToken(
      accessToken,
      harness.TOKEN_SIGNING_KEY,
      { issuer: BASE },
    );
    expect(verified.valid).toBe(true);
    if (!verified.valid) return;
    expect(verified.claims.sub).toBe(ME);
    const jkt = verified.claims.cnf.jkt;

    // 4. A Resource Server completes the binding: a DPoP proof for a protected
    //    request, carrying the access-token hash, verifies against cnf.jkt.
    const rsProof = await makeProof(key, "GET", `${BASE}/micropub`, {
      ath: await s256(accessToken),
    });
    const rsResult = await verifyDpopProof({
      proof: rsProof,
      htm: "GET",
      htu: `${BASE}/micropub`,
      accessToken,
      expectedJkt: jkt,
    });
    expect(rsResult.valid).toBe(true);
  });

  it("rejects a token request whose DPoP proof is for a different key", async () => {
    const challenge = await s256(CODE_VERIFIER);
    const handler = autoApproveHandler();
    const authRes = await handler(
      new Request(await authorizeUrl(challenge), { redirect: "manual" }),
      harness,
      ctx,
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get(
      "code",
    )!;

    const key = await makeDpopKey();
    const proof = await makeProof(key, "POST", `${BASE}/token`);
    const tokenRes = await handler(
      new Request(`${BASE}/token`, {
        method: "POST",
        headers: { DPoP: proof },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: CODE_VERIFIER,
        }),
      }),
      harness,
      ctx,
    );
    expect(tokenRes.status).toBe(200);
    const { access_token } = (await tokenRes.json()) as {
      access_token: string;
    };
    const verified = await verifyAccessToken(
      access_token,
      harness.TOKEN_SIGNING_KEY,
      { issuer: BASE },
    );
    if (!verified.valid) throw new Error("expected valid token");

    // A proof signed by a *different* key must not satisfy the binding.
    const otherKey = await makeDpopKey();
    const otherProof = await makeProof(otherKey, "GET", `${BASE}/micropub`, {
      ath: await s256(access_token),
    });
    const rsResult = await verifyDpopProof({
      proof: otherProof,
      htm: "GET",
      htu: `${BASE}/micropub`,
      accessToken: access_token,
      expectedJkt: verified.claims.cnf.jkt,
    });
    expect(rsResult.valid).toBe(false);
    expect(rsResult.reason).toBe("jkt_mismatch");
  });
});

describe("@dwk/indieauth authorization endpoint validation", () => {
  it("requires PKCE", async () => {
    const handler = autoApproveHandler();
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("state", "s");
    const res = await handler(
      new Request(url.toString(), { redirect: "manual" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
  });

  it("rejects a redirect_uri carrying a fragment", async () => {
    const handler = autoApproveHandler();
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", `${REDIRECT_URI}#frag`);
    url.searchParams.set("code_challenge", await s256(CODE_VERIFIER));
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handler(
      new Request(url.toString(), { redirect: "manual" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 (not 500) on a malformed token request body", async () => {
    const handler = autoApproveHandler();
    const res = await handler(
      new Request(`${BASE}/token`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: "not actually multipart",
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a cross-origin redirect_uri", async () => {
    const handler = autoApproveHandler();
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", "https://evil.example/cb");
    url.searchParams.set("code_challenge", await s256(CODE_VERIFIER));
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handler(
      new Request(url.toString(), { redirect: "manual" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns the hook's Response when it takes over (login/consent page)", async () => {
    const handler = createIndieAuth(
      baseConfig(() => new Response("login", { status: 401 })),
    );
    const res = await handler(
      new Request(await authorizeUrl(await s256(CODE_VERIFIER)), {
        redirect: "manual",
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("login");
  });
});

describe("@dwk/indieauth token endpoint", () => {
  async function getCode(handler = autoApproveHandler()): Promise<string> {
    const authRes = await handler(
      new Request(await authorizeUrl(await s256(CODE_VERIFIER)), {
        redirect: "manual",
      }),
      harness,
      ctx,
    );
    return new URL(authRes.headers.get("location")!).searchParams.get("code")!;
  }

  it("rejects a missing DPoP proof", async () => {
    const handler = autoApproveHandler();
    const code = await getCode(handler);
    const res = await handler(
      new Request(`${BASE}/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: CODE_VERIFIER,
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_dpop_proof",
    );
  });

  it("rejects a wrong PKCE verifier", async () => {
    const handler = autoApproveHandler();
    const code = await getCode(handler);
    const key = await makeDpopKey();
    const res = await handler(
      new Request(`${BASE}/token`, {
        method: "POST",
        headers: { DPoP: await makeProof(key, "POST", `${BASE}/token`) },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: "wrong-verifier-wrong-verifier-wrong-verifier-xx",
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  it("redeems each code only once", async () => {
    const handler = autoApproveHandler();
    const code = await getCode(handler);
    const key = await makeDpopKey();
    const tokenReq = async () =>
      new Request(`${BASE}/token`, {
        method: "POST",
        headers: { DPoP: await makeProof(key, "POST", `${BASE}/token`) },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: CODE_VERIFIER,
        }),
      });

    const first = await handler(await tokenReq(), harness, ctx);
    expect(first.status).toBe(200);
    const second = await handler(await tokenReq(), harness, ctx);
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });
});

describe("@dwk/indieauth profile-URL exchange", () => {
  it("returns the profile at the authorization endpoint (no token)", async () => {
    const handler = autoApproveHandler([]);
    const authRes = await handler(
      new Request(await authorizeUrl(await s256(CODE_VERIFIER), ""), {
        redirect: "manual",
      }),
      harness,
      ctx,
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const res = await handler(
      new Request(`${BASE}/authorize`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: CODE_VERIFIER,
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { me: string };
    expect(body.me).toBe(ME);
  });
});

describe("@dwk/indieauth revocation", () => {
  it("revokes an issued token", async () => {
    const handler = autoApproveHandler();
    const store = createIndieAuthStore(harness);
    const authRes = await handler(
      new Request(await authorizeUrl(await s256(CODE_VERIFIER)), {
        redirect: "manual",
      }),
      harness,
      ctx,
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const key = await makeDpopKey();
    const tokenRes = await handler(
      new Request(`${BASE}/token`, {
        method: "POST",
        headers: { DPoP: await makeProof(key, "POST", `${BASE}/token`) },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: CODE_VERIFIER,
        }),
      }),
      harness,
      ctx,
    );
    const { access_token } = (await tokenRes.json()) as {
      access_token: string;
    };
    const verified = await verifyAccessToken(
      access_token,
      harness.TOKEN_SIGNING_KEY,
      { issuer: BASE },
    );
    if (!verified.valid) throw new Error("expected valid token");
    const now = Math.floor(Date.now() / 1000);
    expect(await store.isTokenActive(verified.claims.jti, now)).toBe(true);

    const revRes = await handler(
      new Request(`${BASE}/revocation`, {
        method: "POST",
        body: new URLSearchParams({ token: access_token }),
      }),
      harness,
      ctx,
    );
    expect(revRes.status).toBe(200);
    expect(await store.isTokenActive(verified.claims.jti, now)).toBe(false);
  });
});

describe("@dwk/indieauth hardening (issue #41)", () => {
  const key = makeDpopKey();

  async function exchange(
    handler: ReturnType<typeof createIndieAuth>,
    code: string,
    tokenUrl = `${BASE}/token`,
  ): Promise<Response> {
    const dpopKey = await key;
    return handler(
      new Request(tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          DPoP: await makeProof(dpopKey, "POST", `${BASE}/token`),
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: CODE_VERIFIER,
        }),
      }),
      harness,
      ctx,
    );
  }

  it("drops granted scopes the server does not advertise as supported", async () => {
    // scopesSupported is ["create", "update", "media"]; the hook tries to grant
    // an unsupported "delete" scope alongside a supported "create".
    const handler = autoApproveHandler(["create", "delete"]);
    const authRes = await handler(
      new Request(await authorizeUrl(await s256(CODE_VERIFIER)), {
        redirect: "manual",
      }),
      harness,
      ctx,
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const tokenRes = await exchange(handler, code);
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { scope: string };
    expect(body.scope).toBe("create");
  });

  it("canonicalizes the approved `me` before persisting it", async () => {
    // The hook returns a non-canonical profile URL (empty path).
    const handler = createIndieAuth(
      baseConfig(() => ({ me: "https://alice.example.com" })),
    );
    const authRes = await handler(
      new Request(await authorizeUrl(await s256(CODE_VERIFIER)), {
        redirect: "manual",
      }),
      harness,
      ctx,
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const tokenRes = await exchange(handler, code);
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { me: string };
    expect(body.me).toBe("https://alice.example.com/");
  });

  it("rejects an approval whose `me` is not a valid profile URL", async () => {
    const handler = createIndieAuth(
      baseConfig(() => ({ me: "https://user:pw@alice.example.com/" })),
    );
    const res = await handler(
      new Request(await authorizeUrl(await s256(CODE_VERIFIER)), {
        redirect: "manual",
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("server_error");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("binds the DPoP proof to the advertised token endpoint, not request.url", async () => {
    // Simulate a path-rewriting proxy: the request arrives on a different
    // origin but the same `/token` path, while the proof targets the advertised
    // token endpoint. Binding to request.url would reject this; binding to the
    // configured endpoint accepts it.
    const handler = autoApproveHandler();
    const authRes = await handler(
      new Request(await authorizeUrl(await s256(CODE_VERIFIER)), {
        redirect: "manual",
      }),
      harness,
      ctx,
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const tokenRes = await exchange(
      handler,
      code,
      "https://internal-proxy.example/token",
    );
    expect(tokenRes.status).toBe(200);
  });

  it("rejects an http (non-loopback) client_id / redirect_uri", async () => {
    const handler = autoApproveHandler();
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "http://app.example.org/");
    url.searchParams.set("redirect_uri", "http://app.example.org/callback");
    url.searchParams.set("code_challenge", await s256(CODE_VERIFIER));
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handler(
      new Request(url.toString(), { redirect: "manual" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });

  it("permits an http loopback client_id / redirect_uri for local dev", async () => {
    const handler = createIndieAuth(baseConfig(() => ({ me: ME })));
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "http://127.0.0.1/");
    url.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
    url.searchParams.set("state", "s");
    url.searchParams.set("code_challenge", await s256(CODE_VERIFIER));
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handler(
      new Request(url.toString(), { redirect: "manual" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(302);
    expect(
      new URL(res.headers.get("location")!).searchParams.get("code"),
    ).toBeTruthy();
  });

  it("rejects a client_id / redirect_uri with embedded credentials", async () => {
    const handler = autoApproveHandler();
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "https://evil@app.example.org/");
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("code_challenge", await s256(CODE_VERIFIER));
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handler(
      new Request(url.toString(), { redirect: "manual" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a redirect_uri carrying dot path segments", async () => {
    const handler = autoApproveHandler();
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", "https://app.example.org/../evil");
    url.searchParams.set("code_challenge", await s256(CODE_VERIFIER));
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handler(
      new Request(url.toString(), { redirect: "manual" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-loopback IP-literal client_id", async () => {
    const handler = autoApproveHandler();
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "https://203.0.113.5/");
    url.searchParams.set("redirect_uri", "https://203.0.113.5/callback");
    url.searchParams.set("code_challenge", await s256(CODE_VERIFIER));
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handler(
      new Request(url.toString(), { redirect: "manual" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("@dwk/indieauth routing and method handling", () => {
  it("returns 405 for a non-GET on the metadata endpoint", async () => {
    const handler = autoApproveHandler();
    const res = await handler(
      new Request(`${BASE}/.well-known/oauth-authorization-server`, {
        method: "POST",
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("returns 405 for a non-POST on the token endpoint", async () => {
    const handler = autoApproveHandler();
    const res = await handler(new Request(`${BASE}/token`), harness, ctx);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("returns 405 for a non-POST on the revocation endpoint", async () => {
    const handler = autoApproveHandler();
    const res = await handler(new Request(`${BASE}/revocation`), harness, ctx);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("returns 405 for an unsupported method on the authorization endpoint", async () => {
    const handler = autoApproveHandler();
    const res = await handler(
      new Request(`${BASE}/authorize`, { method: "DELETE" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });

  it("returns 404 for an unrouted path", async () => {
    const handler = autoApproveHandler();
    const res = await handler(new Request(`${BASE}/nope`), harness, ctx);
    expect(res.status).toBe(404);
  });

  it("redirects with unsupported_response_type for response_type=token", async () => {
    const handler = autoApproveHandler();
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("response_type", "token");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("state", "s");
    url.searchParams.set("code_challenge", await s256(CODE_VERIFIER));
    url.searchParams.set("code_challenge_method", "S256");
    const res = await handler(
      new Request(url.toString(), { redirect: "manual" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("unsupported_response_type");
  });
});

describe("@dwk/indieauth token endpoint error paths", () => {
  async function codeFor(
    handler: ReturnType<typeof createIndieAuth>,
  ): Promise<string> {
    const authRes = await handler(
      new Request(await authorizeUrl(await s256(CODE_VERIFIER)), {
        redirect: "manual",
      }),
      harness,
      ctx,
    );
    return new URL(authRes.headers.get("location")!).searchParams.get("code")!;
  }

  it("rejects an unsupported grant_type", async () => {
    const handler = autoApproveHandler();
    const res = await handler(
      new Request(`${BASE}/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unsupported_grant_type",
    );
  });

  it("rejects a request missing required fields", async () => {
    const handler = autoApproveHandler();
    const res = await handler(
      new Request(`${BASE}/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "authorization_code" }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });

  it("rejects when the client_id does not match the authorization request", async () => {
    const handler = autoApproveHandler();
    const code = await codeFor(handler);
    const res = await handler(
      new Request(`${BASE}/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: "https://other-app.example/",
          redirect_uri: REDIRECT_URI,
          code_verifier: CODE_VERIFIER,
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  it("rejects a present-but-invalid DPoP proof", async () => {
    const handler = autoApproveHandler();
    const code = await codeFor(handler);
    const res = await handler(
      new Request(`${BASE}/token`, {
        method: "POST",
        headers: { DPoP: "not.a.valid.proof" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: CODE_VERIFIER,
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_dpop_proof",
    );
  });
});

describe("@dwk/indieauth revocation no-ops (RFC 7009)", () => {
  it("returns 200 with no token parameter", async () => {
    const handler = autoApproveHandler();
    const res = await handler(
      new Request(`${BASE}/revocation`, {
        method: "POST",
        body: new URLSearchParams({}),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("returns 200 for an unparseable token (silently accepted)", async () => {
    const handler = autoApproveHandler();
    const res = await handler(
      new Request(`${BASE}/revocation`, {
        method: "POST",
        body: new URLSearchParams({ token: "not-a-real-token" }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(200);
  });
});

describe("@dwk/indieauth fails loudly on missing bindings", () => {
  it("throws when the signing key is absent", async () => {
    const handler = autoApproveHandler();
    await expect(
      handler(
        new Request(`${BASE}/.well-known/oauth-authorization-server`),
        { AUTH_DB: harness.AUTH_DB } as IndieAuthEnv,
        ctx,
      ),
    ).rejects.toThrow(/TOKEN_SIGNING_KEY/);
  });

  it("throws when the D1 binding is absent", async () => {
    const handler = autoApproveHandler();
    await expect(
      handler(
        new Request(`${BASE}/.well-known/oauth-authorization-server`),
        { TOKEN_SIGNING_KEY: "k" } as IndieAuthEnv,
        ctx,
      ),
    ).rejects.toThrow(/AUTH_DB/);
  });
});
