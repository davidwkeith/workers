import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { CalendarEvent } from "@dwk/calendar";
import { parseTurtle, quadToStored, serialize, storedToQuad } from "@dwk/rdf";

import {
  calendarEventToQuads,
  createSolidPod,
  quadsToCalendarEvent,
  type SolidPodEnv,
} from "./index.js";

/**
 * End-to-end tests over the real Worker front door + per-pod Durable Object,
 * exercising the issue's acceptance criteria: authenticated GET through WAC,
 * `solid:where` PATCH (match and no-bind → 409), and `If-Match` preconditioned
 * writes — plus auth, DPoP replay, content negotiation, and LDP basics.
 */

const testEnv = env as unknown as SolidPodEnv;

const ISSUER = "https://issuer.example";
const OWNER = "https://owner.example/profile#me";
const BOB = "https://bob.example/profile#me";

// ---------------------------------------------------------------------------
// Crypto fixtures (ES256 issuer key + per-agent DPoP keys)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: CryptoKey,
): Promise<string> {
  const signingInput = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(
    enc.encode(JSON.stringify(payload)),
  )}`;
  const sig = await crypto.subtle.sign(SIGN, key, enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function sha256b64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return b64url(new Uint8Array(digest));
}

/** RFC 7638 EC thumbprint, matching `@dwk/dpop`'s canonicalization. */
async function ecThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: "EC",
    x: jwk.x,
    y: jwk.y,
  });
  return sha256b64url(canonical);
}

interface KeyPairJwk {
  readonly privateKey: CryptoKey;
  readonly publicJwk: JsonWebKey;
}

async function generateEc(): Promise<KeyPairJwk> {
  const pair = (await crypto.subtle.generateKey(ECDSA, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;
  return { privateKey: pair.privateKey, publicJwk };
}

let issuerKey: KeyPairJwk;
let issuerJwk: JsonWebKey;
const agentKeys = new Map<string, KeyPairJwk>();

async function agentKey(webid: string): Promise<KeyPairJwk> {
  let key = agentKeys.get(webid);
  if (!key) {
    key = await generateEc();
    agentKeys.set(webid, key);
  }
  return key;
}

beforeAll(async () => {
  issuerKey = await generateEc();
  issuerJwk = { ...issuerKey.publicJwk, kid: "issuer-1" } as JsonWebKey;
});

/** Mint a DPoP-bound access token for `webid`, bound to `jkt`. */
async function mintToken(webid: string, jkt: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { alg: "ES256", typ: "at+jwt", kid: "issuer-1" },
    {
      iss: ISSUER,
      aud: "solid",
      sub: webid,
      webid,
      iat: now,
      exp: now + 600,
      cnf: { jkt },
    },
    issuerKey.privateKey,
  );
}

/** Build a DPoP proof for a request, optionally reusing a `jti`. */
async function dpopProof(
  method: string,
  url: string,
  key: KeyPairJwk,
  token: string,
  jti = crypto.randomUUID(),
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { alg: "ES256", typ: "dpop+jwt", jwk: key.publicJwk },
    {
      htu: url,
      htm: method,
      iat: now,
      jti,
      ath: await sha256b64url(token),
    },
    key.privateKey,
  );
}

interface ReqInit {
  readonly webid?: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  /** Reuse a fixed `jti` to exercise replay detection. */
  readonly jti?: string;
}

/** Construct a (optionally authenticated) request to the pod. */
async function podRequest(
  method: string,
  url: string,
  init: ReqInit = {},
): Promise<Request> {
  const headers = new Headers(init.headers);
  if (init.webid) {
    const key = await agentKey(init.webid);
    const jkt = await ecThumbprint(key.publicJwk);
    const token = await mintToken(init.webid, jkt);
    headers.set("authorization", `DPoP ${token}`);
    headers.set("dpop", await dpopProof(method, url, key, token, init.jti));
  }
  return new Request(url, {
    method,
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

// ---------------------------------------------------------------------------
// Pod harness: a fresh DO (unique origin) per test for isolation.
// ---------------------------------------------------------------------------

interface Pod {
  readonly base: string;
  send(method: string, path: string, init?: ReqInit): Promise<Response>;
}

function freshPod(
  owner: string = OWNER,
  extra: Partial<Parameters<typeof createSolidPod>[0]> = {},
): Pod {
  const base = `https://${crypto.randomUUID()}.pod.example`;
  const handler = createSolidPod({
    baseUrl: base,
    issuer: ISSUER,
    audience: "solid",
    jwks: [issuerJwk],
    owner,
    ...extra,
  });
  return {
    base,
    async send(method, path, init) {
      const request = await podRequest(method, `${base}${path}`, init);
      return handler(request, testEnv, {} as ExecutionContext);
    },
  };
}

const TURTLE = "text/turtle";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("@dwk/solid-pod auth", () => {
  it("rejects a token with a bad signature (401)", async () => {
    const pod = freshPod();
    // Tamper: present a syntactically valid but unsigned-by-issuer token.
    const res = await pod.send("GET", "/doc", {
      headers: { authorization: "DPoP not.a.jwt" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("DPoP");
  });

  it("lets the owner create and read a resource", async () => {
    const pod = freshPod();
    const put = await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    expect(put.status).toBe(201);
    expect(put.headers.get("etag")).toBeTruthy();

    const get = await pod.send("GET", "/doc", { webid: OWNER });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain(TURTLE);
  });
});

describe("@dwk/solid-pod blob bodies", () => {
  it("streams a binary PUT to R2 and serves it back", async () => {
    const pod = freshPod();
    const payload = "binary body-not-rdf";
    const put = await pod.send("PUT", "/blob", {
      webid: OWNER,
      body: payload,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(put.status).toBe(201);
    // A blob write returns a strong, per-resource opaque ETag (not the content
    // hash, which would collide across distinct resources sharing the bytes).
    expect(put.headers.get("etag")).toMatch(
      /^"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"$/,
    );

    const get = await pod.send("GET", "/blob", { webid: OWNER });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain(
      "application/octet-stream",
    );
    const bytes = new Uint8Array(await get.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe(payload);
  });

  it("offloads RDF over the inline ceiling to R2 as an opaque blob", async () => {
    // Tiny ceiling so a perfectly ordinary Turtle body overflows it and is
    // streamed to R2 instead of parsed into the quad store.
    const pod = freshPod(OWNER, { maxInlineBytes: 16 });
    const turtle = `<#a> <#b> <#c> .\n<#d> <#e> <#f> .\n<#g> <#h> <#i> .`;
    const put = await pod.send("PUT", "/big.ttl", {
      webid: OWNER,
      body: turtle,
      headers: { "content-type": TURTLE },
    });
    expect(put.status).toBe(201);
    expect(put.headers.get("etag")).toMatch(
      /^"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"$/,
    );

    // It round-trips verbatim (opaque blob), not re-serialized from quads.
    const get = await pod.send("GET", "/big.ttl", { webid: OWNER });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(turtle);
  });

  it("still parses small RDF into the quad store (PATCH applies)", async () => {
    // A small body under the ceiling stays in the quad store, so N3 Patch works.
    const pod = freshPod(OWNER, { maxInlineBytes: 1024 });
    await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const patch = await pod.send("PATCH", "/doc", {
      webid: OWNER,
      body: `_:p a <http://www.w3.org/ns/solid/terms#InsertDeletePatch> ;
  <http://www.w3.org/ns/solid/terms#inserts> { <#x> <#y> <#z> . } .`,
      headers: { "content-type": "text/n3" },
    });
    expect(patch.status).toBe(204);
  });
});

describe("@dwk/solid-pod access-token validation (issue #35)", () => {
  /**
   * Build DPoP-bound auth headers for `webid` with a fully custom token header
   * and extra claims, so individual JWT-validation gaps can be exercised
   * (header `typ`, an unknown `kid`, a future `nbf`) against the real handler.
   */
  async function customAuth(
    method: string,
    url: string,
    webid: string,
    header: Record<string, unknown>,
    payloadExtra: Record<string, unknown> = {},
  ): Promise<Record<string, string>> {
    const key = await agentKey(webid);
    const jkt = await ecThumbprint(key.publicJwk);
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      header,
      {
        iss: ISSUER,
        aud: "solid",
        sub: webid,
        webid,
        iat: now,
        exp: now + 600,
        cnf: { jkt },
        ...payloadExtra,
      },
      issuerKey.privateKey,
    );
    return {
      authorization: `DPoP ${token}`,
      dpop: await dpopProof(method, url, key, token),
    };
  }

  it("rejects an access token whose typ is not at+jwt (token-type confusion)", async () => {
    const pod = freshPod();
    const headers = await customAuth("GET", `${pod.base}/doc`, OWNER, {
      alg: "ES256",
      typ: "id+jwt",
      kid: "issuer-1",
    });
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("token_type_invalid");
  });

  it("rejects an access token with no typ header", async () => {
    const pod = freshPod();
    const headers = await customAuth("GET", `${pod.base}/doc`, OWNER, {
      alg: "ES256",
      kid: "issuer-1",
    });
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("token_type_invalid");
  });

  it("accepts the application/at+jwt media-type form of typ", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const headers = await customAuth("GET", `${pod.base}/doc`, OWNER, {
      alg: "ES256",
      typ: "application/at+jwt",
      kid: "issuer-1",
    });
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(200);
  });

  it("honors accessTokenType: null to skip the typ check", async () => {
    const pod = freshPod(OWNER, { accessTokenType: null });
    await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const headers = await customAuth("GET", `${pod.base}/doc`, OWNER, {
      alg: "ES256",
      typ: "id+jwt",
      kid: "issuer-1",
    });
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(200);
  });

  it("rejects a token naming an unknown kid rather than trying other keys", async () => {
    const pod = freshPod();
    const headers = await customAuth("GET", `${pod.base}/doc`, OWNER, {
      alg: "ES256",
      typ: "at+jwt",
      kid: "does-not-exist",
    });
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("signature_invalid");
  });

  it("rejects a token that is not yet valid (future nbf)", async () => {
    const pod = freshPod();
    const future = Math.floor(Date.now() / 1000) + 600;
    const headers = await customAuth(
      "GET",
      `${pod.base}/doc`,
      OWNER,
      { alg: "ES256", typ: "at+jwt", kid: "issuer-1" },
      { nbf: future },
    );
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      "token_not_yet_valid",
    );
  });

  it("rejects a token whose nbf is present but not a number (RFC 7519 §4.1.5)", async () => {
    const pod = freshPod();
    const headers = await customAuth(
      "GET",
      `${pod.base}/doc`,
      OWNER,
      { alg: "ES256", typ: "at+jwt", kid: "issuer-1" },
      { nbf: "not-a-number" },
    );
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      "token_not_yet_valid",
    );
  });

  it("accepts a token whose nbf is already in the past", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const past = Math.floor(Date.now() / 1000) - 10;
    const headers = await customAuth(
      "GET",
      `${pod.base}/doc`,
      OWNER,
      { alg: "ES256", typ: "at+jwt", kid: "issuer-1" },
      { nbf: past },
    );
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(200);
  });
});

describe("@dwk/solid-pod access-token rejection ladder", () => {
  /** Mint an issuer-signed token with arbitrary claims (good signature). */
  async function mintCustom(payload: Record<string, unknown>): Promise<string> {
    return signJwt(
      { alg: "ES256", typ: "at+jwt", kid: "issuer-1" },
      payload,
      issuerKey.privateKey,
    );
  }

  /** A valid token + DPoP proof pair for `webid`, with claim overrides. */
  async function authHeaders(
    method: string,
    url: string,
    webid: string,
    payloadExtra: Record<string, unknown> = {},
  ): Promise<{ token: string; headers: Record<string, string> }> {
    const key = await agentKey(webid);
    const jkt = await ecThumbprint(key.publicJwk);
    const now = Math.floor(Date.now() / 1000);
    const token = await mintCustom({
      iss: ISSUER,
      aud: "solid",
      sub: webid,
      webid,
      iat: now,
      exp: now + 600,
      cnf: { jkt },
      ...payloadExtra,
    });
    return {
      token,
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await dpopProof(method, url, key, token),
      },
    };
  }

  it("rejects a bearer value that is not a JWT (token_malformed)", async () => {
    const pod = freshPod();
    // A bearer value that does not decode to three JSON segments.
    const res = await pod.send("GET", "/doc", {
      headers: { authorization: "DPoP not-even-base64-dots" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("token_malformed");
  });

  it("rejects when the pod has no verification keys (no_jwks)", async () => {
    // A pod configured with an empty JWKS cannot verify any token; a presented
    // token is rejected before signature checking.
    const base = `https://${crypto.randomUUID()}.pod.example`;
    const handler = createSolidPod({
      baseUrl: base,
      issuer: ISSUER,
      audience: "solid",
      jwks: [],
      owner: OWNER,
    });
    const key = await agentKey(OWNER);
    const jkt = await ecThumbprint(key.publicJwk);
    const token = await mintToken(OWNER, jkt);
    const request = new Request(`${base}/doc`, {
      method: "GET",
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await dpopProof("GET", `${base}/doc`, key, token),
      },
    });
    const res = await handler(request, testEnv, {} as ExecutionContext);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("no_jwks");
  });

  it("rejects a token with the wrong issuer (issuer_mismatch)", async () => {
    const pod = freshPod();
    const { headers } = await authHeaders("GET", `${pod.base}/doc`, OWNER, {
      iss: "https://evil-issuer.example",
    });
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("issuer_mismatch");
  });

  it("rejects a token with the wrong audience (audience_mismatch)", async () => {
    const pod = freshPod();
    const { headers } = await authHeaders("GET", `${pod.base}/doc`, OWNER, {
      aud: "https://some-other-rs.example",
    });
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("audience_mismatch");
  });

  it("rejects an expired token (token_expired)", async () => {
    const pod = freshPod();
    const past = Math.floor(Date.now() / 1000) - 600;
    const { headers } = await authHeaders("GET", `${pod.base}/doc`, OWNER, {
      iat: past - 60,
      exp: past,
    });
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("token_expired");
  });

  it("rejects a token with neither webid nor sub (webid_missing)", async () => {
    const pod = freshPod();
    const key = await agentKey(OWNER);
    const jkt = await ecThumbprint(key.publicJwk);
    const now = Math.floor(Date.now() / 1000);
    const token = await mintCustom({
      iss: ISSUER,
      aud: "solid",
      iat: now,
      exp: now + 600,
      cnf: { jkt },
    });
    const res = await pod.send("GET", "/doc", {
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await dpopProof("GET", `${pod.base}/doc`, key, token),
      },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("webid_missing");
  });

  it("rejects a token with no cnf.jkt confirmation (cnf_missing)", async () => {
    const pod = freshPod();
    const key = await agentKey(OWNER);
    const now = Math.floor(Date.now() / 1000);
    // No `cnf` claim at all: the token is not DPoP-bound.
    const token = await mintCustom({
      iss: ISSUER,
      aud: "solid",
      sub: OWNER,
      webid: OWNER,
      iat: now,
      exp: now + 600,
    });
    const res = await pod.send("GET", "/doc", {
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await dpopProof("GET", `${pod.base}/doc`, key, token),
      },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("cnf_missing");
  });

  it("rejects a valid token presented without a DPoP proof (dpop_missing)", async () => {
    const pod = freshPod();
    const { token } = await authHeaders("GET", `${pod.base}/doc`, OWNER);
    // Present the token but omit the `dpop` proof header entirely.
    const res = await pod.send("GET", "/doc", {
      headers: { authorization: `DPoP ${token}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("dpop_missing");
  });

  it("rejects a token with a garbage DPoP proof (dpop_invalid)", async () => {
    const pod = freshPod();
    const { token } = await authHeaders("GET", `${pod.base}/doc`, OWNER);
    const res = await pod.send("GET", "/doc", {
      headers: {
        authorization: `DPoP ${token}`,
        dpop: "not.a.valid.dpop.proof",
      },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("dpop_invalid");
  });

  it("accepts a token whose aud is an array containing an accepted value", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const { headers } = await authHeaders("GET", `${pod.base}/doc`, OWNER, {
      aud: ["https://other-rs.example", "solid"],
    });
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(200);
  });

  it("rejects a token whose aud is neither string nor array (audience_mismatch)", async () => {
    const pod = freshPod();
    const { headers } = await authHeaders("GET", `${pod.base}/doc`, OWNER, {
      aud: 123,
    });
    const res = await pod.send("GET", "/doc", { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("audience_mismatch");
  });

  it("falls back to sub for the agent identity when webid is absent", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    // A token identifying the owner only by `sub` (no `webid` claim) still
    // resolves to the owner agent, so the owner override grants the read.
    const key = await agentKey(OWNER);
    const jkt = await ecThumbprint(key.publicJwk);
    const now = Math.floor(Date.now() / 1000);
    const token = await mintCustom({
      iss: ISSUER,
      aud: "solid",
      sub: OWNER,
      iat: now,
      exp: now + 600,
      cnf: { jkt },
    });
    const res = await pod.send("GET", "/doc", {
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await dpopProof("GET", `${pod.base}/doc`, key, token),
      },
    });
    expect(res.status).toBe(200);
  });

  it("treats a non-DPoP/Bearer Authorization scheme as no credentials", async () => {
    const pod = freshPod();
    // A scheme the edge does not recognize is not a presented credential: the
    // request proceeds anonymous, and WAC challenges the protected resource.
    const res = await pod.send("GET", "/doc", {
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    // The WAC challenge, not a token-rejection (which would carry `error=`).
    expect(res.headers.get("www-authenticate")).not.toContain("error=");
  });
});

describe("@dwk/solid-pod jwksUri resolution", () => {
  /**
   * A pod that resolves its issuer keys from a (mocked) JWKS endpoint instead
   * of a static `jwks`, so the fetch/cache branch of `resolveJwks` runs. The
   * injected `fetch` counts calls so cache hits are observable; `jwksUri` is
   * unique per pod to keep the module-level JWKS cache isolated across tests.
   */
  function jwksPod(jwksResponse?: () => Response | Promise<Response>): {
    base: string;
    calls: () => number;
    send: (method: string, path: string, init?: ReqInit) => Promise<Response>;
  } {
    const base = `https://${crypto.randomUUID()}.pod.example`;
    const jwksUri = `https://issuer.example/jwks/${crypto.randomUUID()}`;
    let calls = 0;
    const stubFetch = (async () => {
      calls += 1;
      return jwksResponse
        ? await jwksResponse()
        : Response.json({ keys: [issuerJwk] });
    }) as unknown as typeof fetch;
    const handler = createSolidPod({
      baseUrl: base,
      issuer: ISSUER,
      audience: "solid",
      jwksUri,
      fetch: stubFetch,
      owner: OWNER,
    });
    return {
      base,
      calls: () => calls,
      async send(method, path, init) {
        const request = await podRequest(method, `${base}${path}`, init);
        return handler(request, testEnv, {} as ExecutionContext);
      },
    };
  }

  it("fetches the issuer JWKS and caches it across requests", async () => {
    const pod = jwksPod();
    const first = await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    expect(first.status).toBe(201);

    const second = await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#d> .",
      headers: { "content-type": TURTLE },
    });
    expect(second.status).toBe(204);
    // The second request verified against the cached keys: one fetch total.
    expect(pod.calls()).toBe(1);
  });

  it("rejects (no_jwks) when the JWKS endpoint is unreachable", async () => {
    const pod = jwksPod(() => new Response("upstream down", { status: 503 }));
    const res = await pod.send("GET", "/doc", { webid: OWNER });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("no_jwks");
  });

  it("rejects (no_jwks) when the JWKS body has no keys array", async () => {
    const pod = jwksPod(() => Response.json({ not: "a keyset" }));
    const res = await pod.send("GET", "/doc", { webid: OWNER });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("no_jwks");
  });

  it("rejects (no_jwks) when the JWKS fetch throws", async () => {
    const pod = jwksPod(() => {
      throw new Error("network error");
    });
    const res = await pod.send("GET", "/doc", { webid: OWNER });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("no_jwks");
  });
});

describe("@dwk/solid-pod custom authenticate hook", () => {
  it("uses the hook's authenticated context, bypassing the built-in JWT path", async () => {
    const base = `https://${crypto.randomUUID()}.pod.example`;
    // No issuer/jwks: the hook fully replaces the built-in verifier. It mints a
    // fresh jti per call so successive writes are not flagged as replays.
    const handler = createSolidPod({
      baseUrl: base,
      owner: OWNER,
      authenticate: () => ({
        webid: OWNER,
        jti: crypto.randomUUID(),
        jkt: "hook-jkt",
      }),
    });
    const put = new Request(`${base}/hooked`, {
      method: "PUT",
      headers: { "content-type": TURTLE },
      body: "<#a> <#b> <#c> .",
    });
    const res = await handler(put, testEnv, {} as ExecutionContext);
    expect(res.status).toBe(201);
  });

  it("treats a null hook result as anonymous", async () => {
    const base = `https://${crypto.randomUUID()}.pod.example`;
    const handler = createSolidPod({
      baseUrl: base,
      owner: OWNER,
      authenticate: () => null,
    });
    // Anonymous and unmatched by any ACL: WAC challenges the read.
    const res = await handler(
      new Request(`${base}/secret`, { method: "GET" }),
      testEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});

describe("@dwk/solid-pod fail-loud on missing bindings", () => {
  it("throws when the POD Durable Object binding is absent", async () => {
    const pod = freshPod();
    const request = await podRequest("GET", `${pod.base}/doc`, {
      webid: OWNER,
    });
    const handler = createSolidPod({
      baseUrl: pod.base,
      issuer: ISSUER,
      audience: "solid",
      jwks: [issuerJwk],
      owner: OWNER,
    });
    const brokenEnv = { BLOBS: testEnv.BLOBS } as unknown as SolidPodEnv;
    await expect(
      handler(request, brokenEnv, {} as ExecutionContext),
    ).rejects.toThrow(/missing required Durable Object binding `POD`/);
  });

  it("throws when the BLOBS R2 binding is absent", async () => {
    const pod = freshPod();
    const request = await podRequest("GET", `${pod.base}/doc`, {
      webid: OWNER,
    });
    const handler = createSolidPod({
      baseUrl: pod.base,
      issuer: ISSUER,
      audience: "solid",
      jwks: [issuerJwk],
      owner: OWNER,
    });
    const brokenEnv = { POD: testEnv.POD } as unknown as SolidPodEnv;
    await expect(
      handler(request, brokenEnv, {} as ExecutionContext),
    ).rejects.toThrow(/missing required R2 binding `BLOBS`/);
  });
});

describe("@dwk/solid-pod WAC", () => {
  it("authenticated GET passes when the .acl grants the agent Read", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const acl = `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
<#r> a acl:Authorization ;
  acl:accessTo <${pod.base}/doc> ;
  acl:agent <${BOB}> ;
  acl:mode acl:Read .`;
    const aclRes = await pod.send("PUT", "/doc.acl", {
      webid: OWNER,
      body: acl,
      headers: { "content-type": TURTLE },
    });
    expect(aclRes.status).toBe(201);

    const bobGet = await pod.send("GET", "/doc", { webid: BOB });
    expect(bobGet.status).toBe(200);
  });

  it("denies an agent the .acl does not mention (403)", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    await pod.send("PUT", "/doc.acl", {
      webid: OWNER,
      body: `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
<#r> a acl:Authorization ; acl:accessTo <${pod.base}/doc> ;
  acl:agent <${BOB}> ; acl:mode acl:Read .`,
      headers: { "content-type": TURTLE },
    });
    const stranger = "https://eve.example/card#me";
    const res = await pod.send("GET", "/doc", { webid: stranger });
    expect(res.status).toBe(403);
  });

  it("serves a public resource (foaf:Agent) to an anonymous request", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/pub", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    await pod.send("PUT", "/pub.acl", {
      webid: OWNER,
      body: `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
<#r> a acl:Authorization ; acl:accessTo <${pod.base}/pub> ;
  acl:agentClass foaf:Agent ; acl:mode acl:Read .`,
      headers: { "content-type": TURTLE },
    });
    const anon = await pod.send("GET", "/pub");
    expect(anon.status).toBe(200);
  });

  it("challenges an anonymous request for a protected resource (401)", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/secret", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const anon = await pod.send("GET", "/secret");
    expect(anon.status).toBe(401);
  });

  it("emits WAC-Allow advertising the agent's and the public's privileges on an authenticated GET", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    // Bob holds Read+Write; the public (foaf:Agent) holds only Read.
    await pod.send("PUT", "/doc.acl", {
      webid: OWNER,
      body: `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
<#bob> a acl:Authorization ; acl:accessTo <${pod.base}/doc> ;
  acl:agent <${BOB}> ; acl:mode acl:Read, acl:Write .
<#pub> a acl:Authorization ; acl:accessTo <${pod.base}/doc> ;
  acl:agentClass foaf:Agent ; acl:mode acl:Read .`,
      headers: { "content-type": TURTLE },
    });

    const bobGet = await pod.send("GET", "/doc", { webid: BOB });
    expect(bobGet.status).toBe(200);
    // `write` implies `append`, so the user group lists both.
    expect(bobGet.headers.get("wac-allow")).toBe(
      'user="read write append",public="read"',
    );
  });

  it("emits WAC-Allow with the public privileges for an anonymous GET", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/pub", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    await pod.send("PUT", "/pub.acl", {
      webid: OWNER,
      body: `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
<#r> a acl:Authorization ; acl:accessTo <${pod.base}/pub> ;
  acl:agentClass foaf:Agent ; acl:mode acl:Read .`,
      headers: { "content-type": TURTLE },
    });

    const anon = await pod.send("GET", "/pub");
    expect(anon.status).toBe(200);
    // An anonymous request is its own public; user and public coincide.
    expect(anon.headers.get("wac-allow")).toBe('user="read",public="read"');
  });
});

describe("@dwk/solid-pod Allow header", () => {
  it("advertises the supported methods on a successful GET", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const get = await pod.send("GET", "/doc", { webid: OWNER });
    expect(get.status).toBe(200);
    const allow = get.headers.get("allow") ?? "";
    expect(allow).toContain("GET");
    expect(allow).toContain("PUT");
    expect(allow).toContain("DELETE");
  });
});

describe("@dwk/solid-pod N3 Patch", () => {
  const PATCH_CT = "text/n3";

  async function seed(pod: Pod): Promise<void> {
    await pod.send("PUT", "/card", {
      webid: OWNER,
      body: `@prefix ex: <http://example.org/> .
<${"https://x/"}me> ex:name "Old" .`,
      headers: { "content-type": TURTLE },
    });
  }

  it("applies a patch whose solid:where binds", async () => {
    const pod = freshPod();
    await seed(pod);
    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:where   { <https://x/me> ex:name "Old" . } ;
  solid:deletes { <https://x/me> ex:name "Old" . } ;
  solid:inserts { <https://x/me> ex:name "New" . } .`;
    const res = await pod.send("PATCH", "/card", {
      webid: OWNER,
      body: patch,
      headers: { "content-type": PATCH_CT },
    });
    expect(res.status).toBe(204);

    const get = await pod.send("GET", "/card", { webid: OWNER });
    const body = await get.text();
    expect(body).toContain('"New"');
    expect(body).not.toContain('"Old"');
  });

  it("returns 409 when solid:where does not bind", async () => {
    const pod = freshPod();
    await seed(pod);
    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:where   { <https://x/me> ex:name "Nonexistent" . } ;
  solid:inserts { <https://x/me> ex:name "New" . } .`;
    const res = await pod.send("PATCH", "/card", {
      webid: OWNER,
      body: patch,
      headers: { "content-type": PATCH_CT },
    });
    expect(res.status).toBe(409);
  });

  it("authorizes an insert-only patch with acl:Append but not a delete", async () => {
    const pod = freshPod();
    await seed(pod);
    await pod.send("PUT", "/card.acl", {
      webid: OWNER,
      body: `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
<#r> a acl:Authorization ; acl:accessTo <${pod.base}/card> ;
  acl:agent <${BOB}> ; acl:mode acl:Append .`,
      headers: { "content-type": TURTLE },
    });

    const insertOnly = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:inserts { <https://x/me> ex:note "hi" . } .`;
    const ok = await pod.send("PATCH", "/card", {
      webid: BOB,
      body: insertOnly,
      headers: { "content-type": PATCH_CT },
    });
    expect(ok.status).toBe(204);

    const withDelete = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:where   { <https://x/me> ex:name "Old" . } ;
  solid:deletes { <https://x/me> ex:name "Old" . } .`;
    const denied = await pod.send("PATCH", "/card", {
      webid: BOB,
      body: withDelete,
      headers: { "content-type": PATCH_CT },
    });
    expect(denied.status).toBe(403);
  });

  it("returns 422 for a patch missing the InsertDeletePatch type triple", async () => {
    const pod = freshPod();
    await seed(pod);
    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p solid:inserts { <https://x/me> ex:note "hi" . } .`;
    const res = await pod.send("PATCH", "/card", {
      webid: OWNER,
      body: patch,
      headers: { "content-type": PATCH_CT },
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 for a blank node in the inserts formula", async () => {
    const pod = freshPod();
    await seed(pod);
    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:inserts { <https://x/me> ex:knows _:someone . } .`;
    const res = await pod.send("PATCH", "/card", {
      webid: OWNER,
      body: patch,
      headers: { "content-type": PATCH_CT },
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 for more than one solid:where statement", async () => {
    const pod = freshPod();
    await seed(pod);
    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:where { ?s ex:name "Old" . } ;
  solid:where { ?s ex:other "x" . } ;
  solid:inserts { ?s ex:note "hi" . } .`;
    const res = await pod.send("PATCH", "/card", {
      webid: OWNER,
      body: patch,
      headers: { "content-type": PATCH_CT },
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 for a template variable absent from where", async () => {
    const pod = freshPod();
    await seed(pod);
    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:where   { <https://x/me> ex:name "Old" . } ;
  solid:inserts { <https://x/me> ex:friend ?unbound . } .`;
    const res = await pod.send("PATCH", "/card", {
      webid: OWNER,
      body: patch,
      headers: { "content-type": PATCH_CT },
    });
    expect(res.status).toBe(422);
  });

  it("returns 409 when a resolved delete triple is absent (delete_not_found)", async () => {
    const pod = freshPod();
    await seed(pod);
    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:deletes { <https://x/me> ex:name "Gone" . } .`;
    const res = await pod.send("PATCH", "/card", {
      webid: OWNER,
      body: patch,
      headers: { "content-type": PATCH_CT },
    });
    expect(res.status).toBe(409);
  });
});

describe("@dwk/solid-pod If-Match", () => {
  it("honors a correct ETag and rejects a stale one (412)", async () => {
    const pod = freshPod();
    const created = await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const etag = created.headers.get("etag")!;
    expect(etag).toBeTruthy();

    const stale = await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#d> .",
      headers: { "content-type": TURTLE, "if-match": '"stale"' },
    });
    expect(stale.status).toBe(412);

    const fresh = await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#d> .",
      headers: { "content-type": TURTLE, "if-match": etag },
    });
    expect(fresh.status).toBe(204);
  });

  it("supports If-None-Match: * for create-only PUT", async () => {
    const pod = freshPod();
    const first = await pod.send("PUT", "/once", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE, "if-none-match": "*" },
    });
    expect(first.status).toBe(201);
    const again = await pod.send("PUT", "/once", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE, "if-none-match": "*" },
    });
    expect(again.status).toBe(412);
  });
});

describe("@dwk/solid-pod DPoP replay", () => {
  it("rejects a reused jti on a write (401)", async () => {
    const pod = freshPod();
    const jti = crypto.randomUUID();
    const first = await pod.send("PUT", "/a", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
      jti,
    });
    expect(first.status).toBe(201);
    const replay = await pod.send("PUT", "/b", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
      jti,
    });
    expect(replay.status).toBe(401);
  });

  it("does not burn the jti when a precondition fails (issue #34)", async () => {
    const pod = freshPod();
    const created = await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const etag = created.headers.get("etag")!;
    expect(etag).toBeTruthy();

    // A stale If-Match rejects the write (412) before the jti is consumed.
    const jti = crypto.randomUUID();
    const stale = await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#d> .",
      headers: { "content-type": TURTLE, "if-match": '"stale"' },
      jti,
    });
    expect(stale.status).toBe(412);

    // Reusing the same jti on a now-valid retry succeeds: the failed
    // precondition rolled back the replay row instead of burning the proof.
    const retry = await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#d> .",
      headers: { "content-type": TURTLE, "if-match": etag },
      jti,
    });
    expect(retry.status).toBe(204);
  });

  it("does not burn the jti when a patch fails to bind (issue #34)", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/card", {
      webid: OWNER,
      body: `@prefix ex: <http://example.org/> .
<https://x/me> ex:name "Old" .`,
      headers: { "content-type": TURTLE },
    });

    const jti = crypto.randomUUID();
    const noBind = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:where   { <https://x/me> ex:name "Nope" . } ;
  solid:inserts { <https://x/me> ex:note "x" . } .`;
    const conflict = await pod.send("PATCH", "/card", {
      webid: OWNER,
      body: noBind,
      headers: { "content-type": "text/n3" },
      jti,
    });
    expect(conflict.status).toBe(409);

    // The same jti drives a patch that does bind — proof was not consumed.
    const binds = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix ex: <http://example.org/> .
_:p a solid:InsertDeletePatch ;
  solid:where   { <https://x/me> ex:name "Old" . } ;
  solid:inserts { <https://x/me> ex:note "x" . } .`;
    const ok = await pod.send("PATCH", "/card", {
      webid: OWNER,
      body: binds,
      headers: { "content-type": "text/n3" },
      jti,
    });
    expect(ok.status).toBe(204);
  });
});

describe("@dwk/solid-pod anonymous writes", () => {
  /** Owner grants the public agent class Read+Write on `path`. */
  async function grantPublicWrite(pod: Pod, path: string): Promise<void> {
    const acl = await pod.send("PUT", `${path}.acl`, {
      webid: OWNER,
      body: `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
<#r> a acl:Authorization ; acl:accessTo <${pod.base}${path}> ;
  acl:agentClass foaf:Agent ; acl:mode acl:Read, acl:Write .`,
      headers: { "content-type": TURTLE },
    });
    expect(acl.status).toBe(201);
  }

  it("refuses a proof-less write even where WAC grants the public (issue #34)", async () => {
    const pod = freshPod();
    await grantPublicWrite(pod, "/pub");
    const anon = await pod.send("PUT", "/pub", {
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain("DPoP");
  });

  it("permits a proof-less public write only when explicitly opted in", async () => {
    const pod = freshPod(OWNER, { allowAnonymousWrites: true });
    await grantPublicWrite(pod, "/pub");
    const anon = await pod.send("PUT", "/pub", {
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    expect(anon.status).toBe(201);
  });
});

describe("@dwk/solid-pod content negotiation", () => {
  it("serves JSON-LD when requested", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const res = await pod.send("GET", "/doc", {
      webid: OWNER,
      headers: { accept: "application/ld+json" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/ld+json");
    const json = (await res.json()) as unknown;
    expect(Array.isArray(json) || typeof json === "object").toBe(true);
  });

  it("returns 406 when the Accept header offers no serializable type", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const res = await pod.send("GET", "/doc", {
      webid: OWNER,
      headers: { accept: "application/pdf" },
    });
    expect(res.status).toBe(406);
  });
});

describe("@dwk/solid-pod conditional GET (If-None-Match)", () => {
  it("matches a strong ETag inside a list and a weak validator", async () => {
    const pod = freshPod();
    const created = await pod.send("PUT", "/doc", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const etag = created.headers.get("etag")!;
    expect(etag).toMatch(/^".+"$/);

    // The current ETag appears within a comma-separated list ⇒ 304.
    const list = await pod.send("GET", "/doc", {
      webid: OWNER,
      headers: { "if-none-match": `"nomatch", ${etag}` },
    });
    expect(list.status).toBe(304);

    // A weak form of the same validator still matches (weak comparison).
    const weak = await pod.send("GET", "/doc", {
      webid: OWNER,
      headers: { "if-none-match": `W/${etag}` },
    });
    expect(weak.status).toBe(304);

    // A non-matching validator returns the full representation.
    const miss = await pod.send("GET", "/doc", {
      webid: OWNER,
      headers: { "if-none-match": '"stale"' },
    });
    expect(miss.status).toBe(200);
  });
});

describe("@dwk/solid-pod LDP", () => {
  it("POST to a container creates a child and lists it", async () => {
    const pod = freshPod();
    // Establish a container with an ACL the owner controls (owner override).
    const created = await pod.send("POST", "/", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE, slug: "note" },
    });
    expect(created.status).toBe(201);
    const location = created.headers.get("location")!;
    expect(location).toContain("/note");

    const root = await pod.send("GET", "/", { webid: OWNER });
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("contains");
  });

  it("refuses to mint an .acl via Slug for an Append-only agent (issue #28)", async () => {
    const pod = freshPod();
    // Grant BOB only acl:Append on container /c/.
    const aclRes = await pod.send("PUT", "/c/.acl", {
      webid: OWNER,
      body: `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
<#r> a acl:Authorization ;
  acl:accessTo <${pod.base}/c/> ;
  acl:agent <${BOB}> ;
  acl:mode acl:Append .`,
      headers: { "content-type": TURTLE },
    });
    expect(aclRes.status).toBe(201);

    // BOB POSTs with a Slug that would mint the ACL document /c/evil.acl.
    const post = await pod.send("POST", "/c/", {
      webid: BOB,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE, slug: "evil.acl" },
    });
    // The POST is allowed (BOB holds Append on the container), but the server
    // must not honor a Slug that produces a reserved auxiliary resource: a
    // random name is assigned instead of the attacker-chosen `.acl`.
    expect(post.status).toBe(201);
    expect(post.headers.get("location")).not.toMatch(/\.acl$/);

    // No ACL document exists at the attacker-chosen key.
    const probe = await pod.send("GET", "/c/evil.acl", { webid: OWNER });
    expect(probe.status).toBe(404);
  });

  it("preserves ldp:contains when a container is PUT-updated", async () => {
    const pod = freshPod();
    // Create a child so the container gains an ldp:contains link.
    const child = await pod.send("POST", "/c/", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE, slug: "kid" },
    });
    expect(child.status).toBe(201);

    // Replace the container's own description (no ldp:contains in the body).
    const put = await pod.send("PUT", "/c/", {
      webid: OWNER,
      body: `@prefix dc: <http://purl.org/dc/terms/> .
<> dc:title "My container" .`,
      headers: { "content-type": TURTLE },
    });
    expect(put.status).toBe(204);

    // The containment link survives the metadata update.
    const listing = await pod.send("GET", "/c/", { webid: OWNER });
    const body = await listing.text();
    expect(body).toContain("contains");
    expect(body).toContain("/c/kid");
    expect(body).toContain("My container");
  });

  it("strips a client-forged ldp:contains triple from a container PUT (issue #337)", async () => {
    const pod = freshPod();
    // A real resource that exists elsewhere in the pod.
    const other = await pod.send("PUT", "/other", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    expect(other.status).toBe(201);

    // PUT the container with a forged ldp:contains pointing at that
    // existing-but-unrelated resource; clients never legitimately send
    // containment, so this must not be persisted.
    const put = await pod.send("PUT", "/c/", {
      webid: OWNER,
      body: `@prefix ldp: <http://www.w3.org/ns/ldp#> .
<> ldp:contains <${pod.base}/other> .`,
      headers: { "content-type": TURTLE },
    });
    expect(put.status).toBe(201);

    const listing = await pod.send("GET", "/c/", { webid: OWNER });
    const body = await listing.text();
    expect(body).not.toContain("/other");
  });

  it("DELETE removes a resource (404 thereafter)", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/gone", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const del = await pod.send("DELETE", "/gone", { webid: OWNER });
    expect(del.status).toBe(204);
    const get = await pod.send("GET", "/gone", { webid: OWNER });
    expect(get.status).toBe(404);
  });

  it("refuses to DELETE a non-empty container (409), then allows it once emptied", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/c/kid", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });

    const blocked = await pod.send("DELETE", "/c/", { webid: OWNER });
    expect(blocked.status).toBe(409);

    await pod.send("DELETE", "/c/kid", { webid: OWNER });
    const emptied = await pod.send("DELETE", "/c/", { webid: OWNER });
    expect(emptied.status).toBe(204);
  });

  it("refuses to DELETE the storage root container (405, undeletable)", async () => {
    const pod = freshPod();
    const del = await pod.send("DELETE", "/", { webid: OWNER });
    expect(del.status).toBe(405);
    const allow = del.headers.get("allow") ?? "";
    expect(allow).toContain("GET");
    expect(allow).toContain("PUT");
    expect(allow).not.toContain("DELETE");
  });

  it("OPTIONS on the storage root omits DELETE from Allow", async () => {
    const pod = freshPod();
    const res = await pod.send("OPTIONS", "/");
    expect(res.status).toBe(204);
    const allow = res.headers.get("allow") ?? "";
    expect(allow).toContain("GET");
    expect(allow).toContain("POST");
    expect(allow).not.toContain("DELETE");
  });

  it("still advertises DELETE on a non-root container", async () => {
    const pod = freshPod();
    const res = await pod.send("OPTIONS", "/c/");
    expect(res.status).toBe(204);
    expect(res.headers.get("allow") ?? "").toContain("DELETE");
  });

  it("OPTIONS advertises Accept-Patch", async () => {
    const pod = freshPod();
    const res = await pod.send("OPTIONS", "/anything");
    expect(res.status).toBe(204);
    expect(res.headers.get("accept-patch")).toContain("text/n3");
  });

  it("OPTIONS on a container advertises concrete Accept-Post types", async () => {
    const pod = freshPod();
    const res = await pod.send("OPTIONS", "/c/");
    expect(res.status).toBe(204);
    const acceptPost = res.headers.get("accept-post");
    expect(acceptPost).toContain("text/turtle");
    expect(acceptPost).toContain("application/ld+json");
  });

  it("does not list .acl auxiliaries in a container's ldp:contains", async () => {
    const pod = freshPod();
    // A regular child is a contained member.
    await pod.send("PUT", "/c/kid", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    // An ACL document governing that child is an auxiliary, not a member.
    const acl = await pod.send("PUT", "/c/kid.acl", {
      webid: OWNER,
      body: `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
<#r> a acl:Authorization ; acl:accessTo <${pod.base}/c/kid> ;
  acl:agent <${BOB}> ; acl:mode acl:Read .`,
      headers: { "content-type": TURTLE },
    });
    expect(acl.status).toBe(201);

    const listing = await pod.send("GET", "/c/", { webid: OWNER });
    const body = await listing.text();
    expect(body).toContain("/c/kid");
    // The auxiliary's existence/path must not leak through the listing.
    expect(body).not.toContain("kid.acl");
  });
});

describe("@dwk/solid-pod LDN inbox discovery", () => {
  const LDP_INBOX = "http://www.w3.org/ns/ldp#inbox";

  it("advertises a resource's ldp:inbox as a Link header on GET", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/card", {
      webid: OWNER,
      body: `<> <${LDP_INBOX}> </inbox/> .`,
      headers: { "content-type": TURTLE },
    });

    const get = await pod.send("GET", "/card", { webid: OWNER });
    expect(get.status).toBe(200);
    const link = get.headers.get("link") ?? "";
    expect(link).toContain(`<${pod.base}/inbox/>; rel="${LDP_INBOX}"`);
    // The LDP type links are still present alongside the inbox advertisement.
    expect(link).toContain('rel="type"');
  });

  it("advertises the inbox on HEAD too", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/card", {
      webid: OWNER,
      body: `<> <${LDP_INBOX}> </inbox/> .`,
      headers: { "content-type": TURTLE },
    });

    const head = await pod.send("HEAD", "/card", { webid: OWNER });
    expect(head.headers.get("link")).toContain(`rel="${LDP_INBOX}"`);
  });

  it("emits no inbox Link for a resource that declares none", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/plain", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });

    const get = await pod.send("GET", "/plain", { webid: OWNER });
    expect(get.headers.get("link") ?? "").not.toContain(LDP_INBOX);
  });
});

describe("@dwk/solid-pod calendar events as RDF (issue #172)", () => {
  const CAROL = "https://carol.example/profile#me";

  const SAMPLE: CalendarEvent = {
    uid: "urn:uuid:party-42",
    title: "Launch Party",
    description: "Come celebrate",
    start: "2026-07-01T18:00:00Z",
    end: "2026-07-01T21:00:00Z",
    locations: [{ name: "Civic Center" }],
    keywords: ["party", "launch"],
    status: "confirmed",
  };

  /** Serialize an event to Turtle the way a client storing it in a pod would. */
  async function eventTurtle(
    event: CalendarEvent,
    subject: string,
  ): Promise<string> {
    return serialize(
      calendarEventToQuads(event, subject).map(storedToQuad),
      TURTLE,
    );
  }

  /**
   * Normalize multi-valued properties for comparison: RDF triples are an
   * unordered set, so the quad store does not preserve the order of repeated
   * `keywords`/`location` triples. Sort them before asserting equality.
   */
  function normalize(event: CalendarEvent): CalendarEvent {
    return {
      ...event,
      ...(event.keywords ? { keywords: [...event.keywords].sort() } : {}),
      ...(event.locations
        ? {
            locations: [...event.locations].sort((a, b) =>
              a.name.localeCompare(b.name),
            ),
          }
        : {}),
    };
  }

  it("creates, reads, and deletes an event as an RDF resource via LDP", async () => {
    const pod = freshPod();
    const subject = `${pod.base}/event`;

    const put = await pod.send("PUT", "/event", {
      webid: OWNER,
      body: await eventTurtle(SAMPLE, subject),
      headers: { "content-type": TURTLE },
    });
    expect(put.status).toBe(201);

    // Read it back through content negotiation and reconstruct the model.
    const get = await pod.send("GET", "/event", {
      webid: OWNER,
      headers: { accept: TURTLE },
    });
    expect(get.status).toBe(200);
    const stored = (await parseTurtle(await get.text())).map(quadToStored);
    expect(normalize(quadsToCalendarEvent(stored, subject))).toEqual(
      normalize(SAMPLE),
    );

    const del = await pod.send("DELETE", "/event", { webid: OWNER });
    expect(del.status).toBe(204);
    const gone = await pod.send("GET", "/event", { webid: OWNER });
    expect(gone.status).toBe(404);
  });

  it("round-trips an event as JSON-LD too", async () => {
    const pod = freshPod();
    const subject = `${pod.base}/event`;
    await pod.send("PUT", "/event", {
      webid: OWNER,
      body: await eventTurtle(SAMPLE, subject),
      headers: { "content-type": TURTLE },
    });

    const get = await pod.send("GET", "/event", {
      webid: OWNER,
      headers: { accept: "application/ld+json" },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("application/ld+json");
  });

  it("lets WAC gate read access to an event resource", async () => {
    const pod = freshPod();
    const subject = `${pod.base}/event`;
    await pod.send("PUT", "/event", {
      webid: OWNER,
      body: await eventTurtle(SAMPLE, subject),
      headers: { "content-type": TURTLE },
    });
    // Grant Bob (only) Read on the event resource.
    await pod.send("PUT", "/event.acl", {
      webid: OWNER,
      body: `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
<#r> a acl:Authorization ; acl:accessTo <${subject}> ;
  acl:agent <${BOB}> ; acl:mode acl:Read .`,
      headers: { "content-type": TURTLE },
    });

    const bob = await pod.send("GET", "/event", { webid: BOB });
    expect(bob.status).toBe(200);
    const stored = (await parseTurtle(await bob.text())).map(quadToStored);
    expect(normalize(quadsToCalendarEvent(stored, subject))).toEqual(
      normalize(SAMPLE),
    );

    // Carol is named by no ACL: denied.
    const carol = await pod.send("GET", "/event", { webid: CAROL });
    expect(carol.status).toBe(403);
  });
});
