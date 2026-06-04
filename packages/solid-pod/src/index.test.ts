import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createSolidPod, type SolidPodEnv } from "./index";

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
    // A content-addressed blob carries a `sha256-` strong ETag.
    expect(put.headers.get("etag")).toMatch(/sha256-[0-9a-f]{64}/);

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
    expect(put.headers.get("etag")).toMatch(/sha256-[0-9a-f]{64}/);

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
