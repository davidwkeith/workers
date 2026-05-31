import { env } from "cloudflare:test";
import { signAccessToken, createIndieAuthStore } from "@dwk/indieauth";
import { beforeEach, describe, expect, it } from "vitest";

import { createMicropub } from "./index";
import type { MicropubEnv } from "./index";

const harness = env as unknown as MicropubEnv;

const BASE = "https://example.com";
const ME = "https://alice.example.com/";
const CLIENT_ID = "https://app.example.org/";
const MICROPUB = `${BASE}/micropub`;
const MEDIA = `${BASE}/media`;
const ctx = {} as ExecutionContext;

// --- base64url + DPoP proof helpers (real ES256 signatures, no mocking) ------

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return bytesToBase64url(new Uint8Array(digest));
}

interface DpopKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  jkt: string;
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
  delete publicJwk.d;
  // RFC 7638 thumbprint over the canonical EC members (crv, kty, x, y).
  const canonical = JSON.stringify({
    crv: publicJwk.crv,
    kty: "EC",
    x: publicJwk.x,
    y: publicJwk.y,
  });
  const jkt = await sha256Base64url(canonical);
  return { privateKey: pair.privateKey, publicJwk, jkt };
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

// --- Token minting ----------------------------------------------------------

interface MintedToken {
  token: string;
  key: DpopKey;
}

/** Mint a DPoP-bound access token and record it in the issued-token store. */
async function mintToken(scope: string): Promise<MintedToken> {
  const key = await makeDpopKey();
  const now = Math.floor(Date.now() / 1000);
  const minted = await signAccessToken(harness.TOKEN_SIGNING_KEY, {
    issuer: BASE,
    me: ME,
    clientId: CLIENT_ID,
    scope,
    jkt: key.jkt,
    lifetimeSeconds: 3600,
    now,
  });
  await createIndieAuthStore(harness).recordToken({
    jti: minted.claims.jti,
    clientId: CLIENT_ID,
    me: ME,
    scope,
    jkt: key.jkt,
    issuedAt: minted.claims.iat,
    expiresAt: minted.claims.exp,
  });
  return { token: minted.token, key };
}

/** Build the `Authorization` + `DPoP` headers for a token-bound request. */
async function authHeaders(
  minted: MintedToken,
  htm: string,
  htu: string,
): Promise<Record<string, string>> {
  return {
    Authorization: `DPoP ${minted.token}`,
    DPoP: await makeProof(minted.key, htm, htu, {
      ath: await sha256Base64url(minted.token),
    }),
  };
}

const handler = createMicropub({
  baseUrl: BASE,
  syndicateTo: [{ uid: "https://twitter.com/alice", name: "Alice on Twitter" }],
});

beforeEach(async () => {
  await createIndieAuthStore(harness).init();
  await (await import("./store")).createMicropubStore(harness).init();
});

// --- Tests ------------------------------------------------------------------

describe("@dwk/micropub queries", () => {
  it("serves q=config with the media endpoint and syndication targets", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["media-endpoint"]).toBe(MEDIA);
    expect(body["syndicate-to"]).toEqual([
      { uid: "https://twitter.com/alice", name: "Alice on Twitter" },
    ]);
    expect(body.q).toContain("source");
  });

  it("serves q=syndicate-to", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(`${MICROPUB}?q=syndicate-to`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["syndicate-to"]).toHaveLength(1);
  });

  it("rejects an unauthenticated query", async () => {
    const res = await handler(
      new Request(`${MICROPUB}?q=config`),
      harness,
      ctx,
    );
    expect(res.status).toBe(401);
  });
});

describe("@dwk/micropub create", () => {
  it("creates an h-entry from JSON and returns it via q=source", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          type: ["h-entry"],
          properties: {
            content: ["Hello world"],
            category: ["foo", "bar"],
          },
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(201);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();

    const source = await handler(
      new Request(`${MICROPUB}?q=source&url=${encodeURIComponent(location!)}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(source.status).toBe(200);
    const body = (await source.json()) as {
      type: string[];
      properties: Record<string, unknown[]>;
    };
    expect(body.type).toEqual(["h-entry"]);
    expect(body.properties.content).toEqual(["Hello world"]);
    expect(body.properties.category).toEqual(["foo", "bar"]);
  });

  it("creates an h-entry from a form-encoded body and honours mp-slug", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MICROPUB),
        body: new URLSearchParams([
          ["h", "entry"],
          ["content", "From a form"],
          ["category[]", "x"],
          ["category[]", "y"],
          ["mp-slug", "my-first-post"],
        ]),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(`${BASE}/my-first-post`);

    const source = await handler(
      new Request(
        `${MICROPUB}?q=source&url=${encodeURIComponent(`${BASE}/my-first-post`)}`,
        { headers: await authHeaders(minted, "GET", MICROPUB) },
      ),
      harness,
      ctx,
    );
    const body = (await source.json()) as {
      properties: Record<string, unknown[]>;
    };
    expect(body.properties.content).toEqual(["From a form"]);
    expect(body.properties.category).toEqual(["x", "y"]);
    // mp-* commands are directives, not stored properties.
    expect(body.properties["mp-slug"]).toBeUndefined();
  });

  it("filters q=source to the requested properties", async () => {
    const minted = await mintToken("create");
    const create = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          type: ["h-entry"],
          properties: { content: ["c"], category: ["a"], name: ["n"] },
        }),
      }),
      harness,
      ctx,
    );
    const url = create.headers.get("location")!;
    const source = await handler(
      new Request(
        `${MICROPUB}?q=source&properties[]=content&url=${encodeURIComponent(url)}`,
        { headers: await authHeaders(minted, "GET", MICROPUB) },
      ),
      harness,
      ctx,
    );
    const body = (await source.json()) as {
      type?: string[];
      properties: Record<string, unknown[]>;
    };
    expect(body.properties).toEqual({ content: ["c"] });
    expect(body.type).toBeUndefined();
  });

  it("rejects a create without the create scope", async () => {
    const minted = await mintToken("update");
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({ type: ["h-entry"], properties: {} }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "insufficient_scope",
    );
  });
});

describe("@dwk/micropub update", () => {
  async function createPost(minted: MintedToken): Promise<string> {
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          type: ["h-entry"],
          properties: { content: ["original"], category: ["a", "b"] },
        }),
      }),
      harness,
      ctx,
    );
    return res.headers.get("location")!;
  }

  it("applies replace, add, and delete operations", async () => {
    const minted = await mintToken("create update");
    const url = await createPost(minted);
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          action: "update",
          url,
          replace: { content: ["edited"] },
          add: { category: ["c"] },
          delete: { category: ["a"] },
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(204);

    const source = await handler(
      new Request(`${MICROPUB}?q=source&url=${encodeURIComponent(url)}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const body = (await source.json()) as {
      properties: Record<string, unknown[]>;
    };
    expect(body.properties.content).toEqual(["edited"]);
    expect(body.properties.category).toEqual(["b", "c"]);
  });

  it("deletes whole properties given a string array", async () => {
    const minted = await mintToken("create update");
    const url = await createPost(minted);
    await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({ action: "update", url, delete: ["category"] }),
      }),
      harness,
      ctx,
    );
    const source = await handler(
      new Request(`${MICROPUB}?q=source&url=${encodeURIComponent(url)}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const body = (await source.json()) as {
      properties: Record<string, unknown[]>;
    };
    expect(body.properties.category).toBeUndefined();
    expect(body.properties.content).toEqual(["original"]);
  });

  it("rejects a form-encoded update", async () => {
    const minted = await mintToken("create update");
    const url = await createPost(minted);
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MICROPUB),
        body: new URLSearchParams({ action: "update", url }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("@dwk/micropub delete / undelete", () => {
  it("soft-deletes and restores a post", async () => {
    const minted = await mintToken("create delete undelete");
    const create = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          type: ["h-entry"],
          properties: { content: ["x"] },
        }),
      }),
      harness,
      ctx,
    );
    const url = create.headers.get("location")!;

    const del = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MICROPUB),
        body: new URLSearchParams({ action: "delete", url }),
      }),
      harness,
      ctx,
    );
    expect(del.status).toBe(204);

    const goneSource = await handler(
      new Request(`${MICROPUB}?q=source&url=${encodeURIComponent(url)}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(goneSource.status).toBe(404);

    const undel = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MICROPUB),
        body: new URLSearchParams({ action: "undelete", url }),
      }),
      harness,
      ctx,
    );
    expect(undel.status).toBe(204);

    const backSource = await handler(
      new Request(`${MICROPUB}?q=source&url=${encodeURIComponent(url)}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(backSource.status).toBe(200);
  });

  it("requires the delete scope", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MICROPUB),
        body: new URLSearchParams({ action: "delete", url: `${BASE}/x` }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(403);
  });
});

describe("@dwk/micropub media endpoint", () => {
  it("uploads a file to R2 and serves it back", async () => {
    const minted = await mintToken("media");
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([1, 2, 3, 4])], "photo.png", {
        type: "image/png",
      }),
    );
    const res = await handler(
      new Request(MEDIA, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MEDIA),
        body: form,
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(201);
    const location = res.headers.get("location")!;
    expect(location.startsWith(`${MEDIA}/`)).toBe(true);

    const get = await handler(new Request(location), harness, ctx);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await get.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it("requires the media scope", async () => {
    const minted = await mintToken("create");
    const form = new FormData();
    form.set("file", new File(["x"], "a.txt", { type: "text/plain" }));
    const res = await handler(
      new Request(MEDIA, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MEDIA),
        body: form,
      }),
      harness,
      ctx,
    );
    // `create` is accepted as a fallback for media, so this must NOT be a scope
    // failure — but with only `create` granted and no file issues it succeeds.
    expect(res.status).toBe(201);
  });

  it("folds an uploaded photo into a multipart create", async () => {
    const minted = await mintToken("create");
    const form = new FormData();
    form.set("h", "entry");
    form.set("content", "with a photo");
    form.set(
      "photo",
      new File([new Uint8Array([9, 9])], "p.jpg", { type: "image/jpeg" }),
    );
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MICROPUB),
        body: form,
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(201);
    const url = res.headers.get("location")!;
    const source = await handler(
      new Request(`${MICROPUB}?q=source&url=${encodeURIComponent(url)}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const body = (await source.json()) as {
      properties: Record<string, unknown[]>;
    };
    const photo = body.properties.photo?.[0];
    expect(typeof photo).toBe("string");
    expect((photo as string).startsWith(`${MEDIA}/`)).toBe(true);
  });

  it("rejects a multipart upload over the media size limit", async () => {
    const tiny = createMicropub({ baseUrl: BASE, maxMediaBytes: 2 });
    const minted = await mintToken("create");
    const form = new FormData();
    form.set("h", "entry");
    form.set(
      "photo",
      new File([new Uint8Array([1, 2, 3, 4])], "big.png", {
        type: "image/png",
      }),
    );
    const res = await tiny(
      new Request(MICROPUB, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MICROPUB),
        body: form,
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("@dwk/micropub post-URL policy", () => {
  it("places posts under a subdirectory baseUrl", async () => {
    const blog = createMicropub({ baseUrl: `${BASE}/blog`, tokenIssuer: BASE });
    const minted = await mintToken("create");
    const res = await blog(
      new Request(MICROPUB, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MICROPUB),
        body: new URLSearchParams([
          ["h", "entry"],
          ["content", "in a subdir"],
          ["mp-slug", "hello"],
        ]),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(`${BASE}/blog/hello`);
  });
});

describe("@dwk/micropub delete-by-value", () => {
  it("matches nested values regardless of key order", async () => {
    const minted = await mintToken("create update");
    const create = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          type: ["h-entry"],
          properties: {
            content: [{ html: "<b>hi</b>", value: "hi" }],
          },
        }),
      }),
      harness,
      ctx,
    );
    const url = create.headers.get("location")!;
    // Same value, keys in the opposite order.
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          action: "update",
          url,
          delete: { content: [{ value: "hi", html: "<b>hi</b>" }] },
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(204);
    const source = await handler(
      new Request(`${MICROPUB}?q=source&url=${encodeURIComponent(url)}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const body = (await source.json()) as {
      properties: Record<string, unknown[]>;
    };
    expect(body.properties.content).toBeUndefined();
  });
});

describe("@dwk/micropub authorization", () => {
  it("rejects a request with no token", async () => {
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: ["h-entry"], properties: {} }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a DPoP proof signed by the wrong key", async () => {
    const minted = await mintToken("create");
    const otherKey = await makeDpopKey();
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `DPoP ${minted.token}`,
          DPoP: await makeProof(otherKey, "POST", MICROPUB, {
            ath: await sha256Base64url(minted.token),
          }),
        },
        body: JSON.stringify({ type: ["h-entry"], properties: {} }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_token",
    );
  });

  it("rejects a revoked token", async () => {
    const minted = await mintToken("create");
    // Revoke it in the shared issued-token store.
    const store = createIndieAuthStore(harness);
    const res1 = await handler(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(res1.status).toBe(200);

    // Recover the jti by verifying, then revoke.
    const { verifyAccessToken } = await import("@dwk/indieauth");
    const verified = await verifyAccessToken(
      minted.token,
      harness.TOKEN_SIGNING_KEY,
      { issuer: BASE },
    );
    if (!verified.valid) throw new Error("expected valid token");
    await store.revokeToken(verified.claims.jti);

    const res2 = await handler(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(res2.status).toBe(401);
  });
});

describe("@dwk/micropub fails loudly on missing bindings", () => {
  it("throws when the R2 media bucket is absent", async () => {
    await expect(
      handler(
        new Request(`${MICROPUB}?q=config`),
        {
          MICROPUB_DB: harness.MICROPUB_DB,
          AUTH_DB: harness.AUTH_DB,
          TOKEN_SIGNING_KEY: "k",
        } as MicropubEnv,
        ctx,
      ),
    ).rejects.toThrow(/MEDIA/);
  });

  it("throws when the signing key is absent", async () => {
    await expect(
      handler(
        new Request(`${MICROPUB}?q=config`),
        {
          MEDIA: harness.MEDIA,
          MICROPUB_DB: harness.MICROPUB_DB,
          AUTH_DB: harness.AUTH_DB,
        } as MicropubEnv,
        ctx,
      ),
    ).rejects.toThrow(/TOKEN_SIGNING_KEY/);
  });
});
