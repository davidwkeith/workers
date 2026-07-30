import { env } from "cloudflare:test";
import { signAccessToken, createIndieAuthStore } from "@dwk/indieauth";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createMicropub,
  createMicropubContactStore,
  createMicropubMediaStore,
  createMicropubVenueStore,
} from "./index.js";
import type { MicropubEnv } from "./index.js";
import { FEDIVERSE_TARGET_UID } from "./fediverse.js";

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
async function mintToken(scope: string, me: string = ME): Promise<MintedToken> {
  const key = await makeDpopKey();
  const now = Math.floor(Date.now() / 1000);
  const minted = await signAccessToken(harness.TOKEN_SIGNING_KEY, {
    issuer: BASE,
    me,
    clientId: CLIENT_ID,
    scope,
    jkt: key.jkt,
    lifetimeSeconds: 3600,
    now,
  });
  await createIndieAuthStore(harness).recordToken({
    jti: minted.claims.jti,
    clientId: CLIENT_ID,
    me,
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
  me: ME,
  syndicateTo: [{ uid: "https://twitter.com/alice", name: "Alice on Twitter" }],
});
const contactStore = createMicropubContactStore(harness);
const contactsHandler = createMicropub({
  baseUrl: BASE,
  me: ME,
  extensions: { proposed: true },
  contacts: createMicropubContactStore,
});
const venueStore = createMicropubVenueStore(harness);
const venuesHandler = createMicropub({
  baseUrl: BASE,
  me: ME,
  extensions: { proposed: true },
  venues: venueStore,
});

beforeEach(async () => {
  await createIndieAuthStore(harness).init();
  await (await import("./store.js")).createMicropubStore(harness).init();
  await contactStore.init();
  await venueStore.init();
  await (await import("./replay.js")).createDpopReplayStore(harness).init();
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

  it("creates an h=event with start/end/location and returns it via q=source", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MICROPUB),
        body: new URLSearchParams([
          ["h", "event"],
          ["name", "Indie Web Meetup"],
          ["start", "2026-07-01T18:00:00-07:00"],
          ["end", "2026-07-01T20:00:00-07:00"],
          ["location", "Portland, OR"],
          ["mp-slug", "meetup"],
        ]),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(`${BASE}/meetup`);

    const source = await handler(
      new Request(
        `${MICROPUB}?q=source&url=${encodeURIComponent(`${BASE}/meetup`)}`,
        { headers: await authHeaders(minted, "GET", MICROPUB) },
      ),
      harness,
      ctx,
    );
    const body = (await source.json()) as {
      type: string[];
      properties: Record<string, unknown[]>;
    };
    expect(body.type).toEqual(["h-event"]);
    expect(body.properties.name).toEqual(["Indie Web Meetup"]);
    expect(body.properties.start).toEqual(["2026-07-01T18:00:00-07:00"]);
    expect(body.properties.end).toEqual(["2026-07-01T20:00:00-07:00"]);
    expect(body.properties.location).toEqual(["Portland, OR"]);
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

describe("@dwk/micropub token transmission method", () => {
  it("rejects a token sent in both the header and the body (RFC 6750 §2)", async () => {
    const minted = await mintToken("create");
    const proof = await makeProof(minted.key, "POST", MICROPUB, {
      ath: await sha256Base64url(minted.token),
    });
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          Authorization: `DPoP ${minted.token}`,
          DPoP: proof,
        },
        body: new URLSearchParams([
          ["h", "entry"],
          ["content", "dup token"],
          ["access_token", minted.token],
        ]),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });

  it("accepts a token in the Authorization header only", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MICROPUB),
        body: new URLSearchParams([
          ["h", "entry"],
          ["content", "header only"],
        ]),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(201);
  });

  it("accepts a token in the request body only", async () => {
    const minted = await mintToken("create");
    const proof = await makeProof(minted.key, "POST", MICROPUB, {
      ath: await sha256Base64url(minted.token),
    });
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: { DPoP: proof },
        body: new URLSearchParams([
          ["h", "entry"],
          ["content", "body only"],
          ["access_token", minted.token],
        ]),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(201);
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
    // A known media type is served inline with its type — and never sniffed.
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await get.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it("serves an uploaded text/html blob as a non-executable download (stored-XSS guard)", async () => {
    const minted = await mintToken("media");
    const form = new FormData();
    form.set(
      "file",
      new File(["<script>alert(1)</script>"], "x.html", {
        type: "text/html",
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
    const get = await handler(
      new Request(res.headers.get("location")!),
      harness,
      ctx,
    );
    expect(get.status).toBe(200);
    // Not served as HTML: forced to an opaque, downloaded blob, never sniffed —
    // so a `media`-scope upload can't execute as script on this origin.
    expect(get.headers.get("content-type")).toBe("application/octet-stream");
    expect(get.headers.get("content-disposition")).toBe("attachment");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects a media upload without the media scope (least privilege)", async () => {
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
    // A `create`-only token does not authorize arbitrary blob uploads to the
    // media endpoint; that requires the dedicated `media` scope.
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "insufficient_scope",
    );
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

  it("never writes media to R2 when a multipart create is unauthorized", async () => {
    const before = (await harness.MEDIA.list()).objects.length;
    const form = new FormData();
    form.set("h", "entry");
    form.set("content", "no auth");
    form.set(
      "photo",
      new File([new Uint8Array([9, 9])], "p.jpg", { type: "image/jpeg" }),
    );
    // No Authorization header and no DPoP proof: authorization must fail…
    const res = await handler(
      new Request(MICROPUB, { method: "POST", body: form }),
      harness,
      ctx,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    // …and the upload must never have been streamed to R2 (auth precedes store).
    const after = (await harness.MEDIA.list()).objects.length;
    expect(after).toBe(before);
  });

  it("rejects a multipart upload over the media size limit", async () => {
    const tiny = createMicropub({ baseUrl: BASE, me: ME, maxMediaBytes: 2 });
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

  it("rejects an oversized media upload with 413 before buffering it", async () => {
    const tiny = createMicropub({ baseUrl: BASE, me: ME, maxMediaBytes: 2 });
    const minted = await mintToken("media");
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], "big.png", {
        type: "image/png",
      }),
    );
    const res = await tiny(
      new Request(MEDIA, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MEDIA),
        body: form,
      }),
      harness,
      ctx,
    );
    // The multipart Content-Length comfortably exceeds the 2-byte limit, so the
    // request is rejected on the header before `formData()` reads the body.
    expect(res.status).toBe(413);
  });
});

describe("@dwk/micropub post-URL policy", () => {
  it("places posts under a subdirectory baseUrl", async () => {
    const blog = createMicropub({
      baseUrl: `${BASE}/blog`,
      me: ME,
      tokenIssuer: BASE,
    });
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

  it("rejects a valid token minted for a different `me`", async () => {
    // A correctly signed, DPoP-bound, in-scope token from the same issuer — but
    // its subject is another user's profile, so it must not publish here.
    const minted = await mintToken("create", "https://mallory.example.com/");
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          type: ["h-entry"],
          properties: { content: ["intruder"] },
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(403);
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

describe("@dwk/micropub DPoP replay", () => {
  it("rejects a replayed proof on a state-changing request", async () => {
    const minted = await mintToken("create");
    // Capture one proof and reuse it verbatim, so both requests carry the same
    // `jti` (a legitimate client mints a fresh proof per request).
    const headers = {
      "content-type": "application/json",
      ...(await authHeaders(minted, "POST", MICROPUB)),
    };
    const body = JSON.stringify({
      type: ["h-entry"],
      properties: { content: ["once"] },
    });

    const first = await handler(
      new Request(MICROPUB, { method: "POST", headers, body }),
      harness,
      ctx,
    );
    expect(first.status).toBe(201);

    const replay = await handler(
      new Request(MICROPUB, { method: "POST", headers, body }),
      harness,
      ctx,
    );
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toBe(
      "invalid_token",
    );
  });

  it("allows reuse of a proof when replay detection is disabled", async () => {
    const lax = createMicropub({
      baseUrl: BASE,
      me: ME,
      checkDpopReplay: false,
    });
    const minted = await mintToken("create");
    const headers = await authHeaders(minted, "GET", MICROPUB);
    const a = await handler(
      new Request(`${MICROPUB}?q=config`, { headers }),
      harness,
      ctx,
    );
    const b = await lax(
      new Request(`${MICROPUB}?q=config`, { headers }),
      harness,
      ctx,
    );
    // Same proof twice: the default handler burns the `jti` on the first read,
    // but the lax handler accepts both.
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe("@dwk/micropub error codes", () => {
  it("uses a registered error code for a missing post", async () => {
    const minted = await mintToken("create update");
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          action: "update",
          url: `${BASE}/does-not-exist`,
          replace: { content: ["x"] },
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(404);
    // `not_found` is not in the Micropub/OAuth error registry; the body uses
    // `invalid_request` while keeping the 404 status.
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });
});

describe("@dwk/micropub update key stripping", () => {
  it("strips mp-* commands from update operands but keeps real properties", async () => {
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
          properties: { content: ["original"] },
        }),
      }),
      harness,
      ctx,
    );
    const url = create.headers.get("location")!;

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
          replace: {
            content: ["edited"],
            "mp-slug": ["sneaky"],
            // `url` is a legitimate mf2 property (e.g. a bookmark target) and
            // must survive the command-key filter.
            url: ["https://example.com/canonical"],
          },
          add: { "mp-syndicate-to": ["https://example.org/feed"] },
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
    const sourceBody = (await source.json()) as {
      properties: Record<string, unknown[]>;
    };
    expect(sourceBody.properties.content).toEqual(["edited"]);
    // `mp-*` commands never reach stored properties...
    expect(sourceBody.properties["mp-slug"]).toBeUndefined();
    expect(sourceBody.properties["mp-syndicate-to"]).toBeUndefined();
    // ...but a real mf2 property like `url` is updated normally.
    expect(sourceBody.properties.url).toEqual([
      "https://example.com/canonical",
    ]);
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

describe("@dwk/micropub routing and method handling", () => {
  it("answers an OPTIONS preflight with CORS headers", async () => {
    const res = await handler(
      new Request(MICROPUB, { method: "OPTIONS" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns 405 for an unsupported method on the micropub endpoint", async () => {
    const res = await handler(
      new Request(MICROPUB, { method: "PUT" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  it("returns 405 for a non-POST on the media endpoint", async () => {
    const res = await handler(new Request(MEDIA), harness, ctx);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });

  it("returns 404 for an unrouted path", async () => {
    const res = await handler(new Request(`${BASE}/nope`), harness, ctx);
    expect(res.status).toBe(404);
  });
});

describe("@dwk/micropub query and action edge cases", () => {
  it("gates proposed source filters, advertises them, and pages them by cursor", async () => {
    const minted = await mintToken("create");
    const filterValue = `issue-362-${crypto.randomUUID()}`;
    const proposed = createMicropub({
      baseUrl: BASE,
      me: ME,
      extensions: { proposed: true },
    });
    for (const content of ["first", "second"]) {
      const created = await proposed(
        new Request(MICROPUB, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(await authHeaders(minted, "POST", MICROPUB)),
          },
          body: JSON.stringify({
            type: ["h-entry"],
            properties: { content: [content], category: [filterValue] },
          }),
        }),
        harness,
        ctx,
      );
      expect(created.status).toBe(201);
    }
    const query = new URLSearchParams({
      q: "source",
      limit: "1",
      "property-value[category]": filterValue,
    });
    const disabled = await handler(
      new Request(`${MICROPUB}?${query}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(disabled.status).toBe(400);
    const config = await proposed(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(
      ((await config.json()) as Record<string, unknown>)["source-filters"],
    ).toBeDefined();
    const first = await proposed(
      new Request(`${MICROPUB}?${query}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const firstBody = (await first.json()) as {
      items: Array<{ properties: { url: string[] } }>;
      "next-cursor"?: string;
    };
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody["next-cursor"]).toEqual(expect.any(String));

    const malformedCursor = new URLSearchParams(query);
    malformedCursor.set("cursor", "not-a-cursor");
    const malformed = await proposed(
      new Request(`${MICROPUB}?${malformedCursor}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(malformed.status).toBe(400);

    const cursorAndOffset = new URLSearchParams(malformedCursor);
    cursorAndOffset.set("offset", "0");
    const conflictingPagination = await proposed(
      new Request(`${MICROPUB}?${cursorAndOffset}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(conflictingPagination.status).toBe(400);

    const emptyQuery = new URLSearchParams({
      q: "source",
      "property-value[category]": `${filterValue}-missing`,
    });
    const empty = await proposed(
      new Request(`${MICROPUB}?${emptyQuery}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const emptyBody = (await empty.json()) as {
      items: unknown[];
      "next-cursor"?: string;
    };
    expect(emptyBody.items).toEqual([]);
    expect(emptyBody).not.toHaveProperty("next-cursor");

    query.set("cursor", firstBody["next-cursor"]!);
    const second = await proposed(
      new Request(`${MICROPUB}?${query}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const secondBody = (await second.json()) as {
      items: Array<{ properties: { url: string[] } }>;
    };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.items[0]!.properties.url[0]).not.toBe(
      firstBody.items[0]!.properties.url[0],
    );
  });

  it("does not advertise or handle proposed q=geo by default", async () => {
    const minted = await mintToken("create");
    const config = await handler(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(((await config.json()) as { q: string[] }).q).not.toContain("geo");

    const geo = await handler(
      new Request(`${MICROPUB}?q=geo&lat=37.786971&lon=-122.399677`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(geo.status).toBe(400);
    expect(((await geo.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });

  it("rejects an unsupported query type", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(`${MICROPUB}?q=mystery`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });

  it("returns list of posts for q=source without a url", async () => {
    const minted = await mintToken("create");
    const res1 = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          ...(await authHeaders(minted, "POST", MICROPUB)),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: ["h-entry"],
          properties: { content: ["list-test-1"] },
        }),
      }),
      harness,
      ctx,
    );
    expect(res1.status).toBe(201);
    const url1 = new URL(res1.headers.get("location") ?? "");
    const res2 = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          ...(await authHeaders(minted, "POST", MICROPUB)),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: ["h-entry"],
          properties: { content: ["list-test-2"] },
        }),
      }),
      harness,
      ctx,
    );
    expect(res2.status).toBe(201);
    const url2 = new URL(res2.headers.get("location") ?? "");
    const res = await handler(
      new Request(`${MICROPUB}?q=source`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      items?: unknown[];
    };
    expect(data).toHaveProperty("items");
    expect(Array.isArray(data.items)).toBe(true);
    const urls = (data.items as Record<string, unknown>[]).map((item) => {
      const props = item.properties as Record<string, unknown>;
      const url = props.url as unknown[] | undefined;
      return url?.[0];
    });
    expect(urls).toContain(url1.href);
    expect(urls).toContain(url2.href);
    const firstItem = data.items?.[0];
    expect(firstItem).toHaveProperty("type");
    expect(firstItem).toHaveProperty("properties");
  });

  it("respects limit parameter on q=source list", async () => {
    const minted = await mintToken("create");
    for (let i = 0; i < 5; i++) {
      await handler(
        new Request(MICROPUB, {
          method: "POST",
          headers: {
            ...(await authHeaders(minted, "POST", MICROPUB)),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: ["h-entry"],
            properties: { content: [`limit-test-${i}`] },
          }),
        }),
        harness,
        ctx,
      );
    }
    const res = await handler(
      new Request(`${MICROPUB}?q=source&limit=2`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { items?: unknown[] };
    expect(data.items).toHaveLength(2);
  });

  it("respects offset parameter on q=source list", async () => {
    const minted = await mintToken("create");
    for (let i = 0; i < 5; i++) {
      await handler(
        new Request(MICROPUB, {
          method: "POST",
          headers: {
            ...(await authHeaders(minted, "POST", MICROPUB)),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: ["h-entry"],
            properties: { content: [`offset-test-${i}`] },
          }),
        }),
        harness,
        ctx,
      );
    }
    const res1 = await handler(
      new Request(`${MICROPUB}?q=source&limit=2&offset=0`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const data1 = (await res1.json()) as { items?: unknown[] };
    const res2 = await handler(
      new Request(`${MICROPUB}?q=source&limit=2&offset=2`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const data2 = (await res2.json()) as { items?: unknown[] };
    expect((data2.items as unknown[]).length).toBeGreaterThan(0);
    expect((data1.items as unknown[]).length).toBeGreaterThan(0);
  });

  it("applies property filtering to q=source list items", async () => {
    const minted = await mintToken("create");
    await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          ...(await authHeaders(minted, "POST", MICROPUB)),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: ["h-entry"],
          properties: { content: ["filter-test"], name: ["title"] },
        }),
      }),
      harness,
      ctx,
    );
    const res2 = await handler(
      new Request(`${MICROPUB}?q=source&properties[]=content`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(res2.status).toBe(200);
    const data = (await res2.json()) as { items?: unknown[] };
    const firstItem = (data.items as Record<string, unknown>[])?.[0];
    expect(firstItem).toHaveProperty("properties");
    expect(
      (firstItem?.properties as Record<string, unknown>) || {},
    ).toHaveProperty("content");
    expect(
      (firstItem?.properties as Record<string, unknown>) || {},
    ).not.toHaveProperty("name");
  });

  it("returns 404 for q=source on a non-existent post", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(`${MICROPUB}?q=source&url=${BASE}/posts/ghost`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("rejects an unknown action", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          ...(await authHeaders(minted, "POST", MICROPUB)),
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "frobnicate", url: `${BASE}/posts/x` }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });

  it("rejects a malformed JSON body", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          ...(await authHeaders(minted, "POST", MICROPUB)),
          "content-type": "application/json",
        },
        body: "{not valid json",
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("@dwk/micropub stable extensions", () => {
  /** Create an h-entry with the given mf2 properties via the default handler. */
  async function createEntry(
    minted: MintedToken,
    properties: Record<string, unknown[]>,
    mount = handler,
  ): Promise<Response> {
    return mount(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({ type: ["h-entry"], properties }),
      }),
      harness,
      ctx,
    );
  }

  it("advertises `category` in q=config's supported queries", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(((await res.json()) as { q: string[] }).q).toContain("category");
  });

  it("advertises configured post-types in q=config", async () => {
    const withTypes = createMicropub({
      baseUrl: BASE,
      me: ME,
      postTypes: [
        { type: "note", name: "Note" },
        { type: "article", name: "Article" },
      ],
    });
    const minted = await mintToken("create");
    const res = await withTypes(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(
      ((await res.json()) as Record<string, unknown>)["post-types"],
    ).toEqual([
      { type: "note", name: "Note" },
      { type: "article", name: "Article" },
    ]);
  });

  it("accepts a valid post-status/visibility and round-trips them", async () => {
    const minted = await mintToken("create");
    const res = await createEntry(minted, {
      content: ["a draft"],
      "post-status": ["draft"],
      visibility: ["unlisted"],
    });
    expect(res.status).toBe(201);
    const location = res.headers.get("location")!;
    const source = await handler(
      new Request(`${MICROPUB}?q=source&url=${encodeURIComponent(location)}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const body = (await source.json()) as {
      properties: Record<string, unknown[]>;
    };
    expect(body.properties["post-status"]).toEqual(["draft"]);
    expect(body.properties.visibility).toEqual(["unlisted"]);
  });

  it("rejects an unknown post-status value", async () => {
    const minted = await mintToken("create");
    const res = await createEntry(minted, {
      content: ["x"],
      "post-status": ["bogus"],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });

  it("rejects an unknown visibility value", async () => {
    const minted = await mintToken("create");
    const res = await createEntry(minted, {
      content: ["x"],
      visibility: ["secret"],
    });
    expect(res.status).toBe(400);
  });

  it("rejects an update that introduces an invalid post-status", async () => {
    const minted = await mintToken("create update");
    const created = await createEntry(minted, { content: ["x"] });
    const location = created.headers.get("location")!;
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          action: "update",
          url: location,
          replace: { "post-status": ["nope"] },
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("q=category returns distinct tags, alphabetised, filterable and limitable", async () => {
    const minted = await mintToken("create");
    await createEntry(minted, {
      content: ["one"],
      category: ["zzcat-indieweb", "zzcat-micropub"],
    });
    await createEntry(minted, {
      content: ["two"],
      category: ["zzcat-indieweb", "zzcat-cloudflare"],
    });

    // Scope assertions with the unique `zzcat-` prefix: the store accumulates
    // rows across tests in this file, so filter rather than assert the whole set.
    const all = await handler(
      new Request(`${MICROPUB}?q=category&filter=zzcat-`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(((await all.json()) as { categories: string[] }).categories).toEqual(
      ["zzcat-cloudflare", "zzcat-indieweb", "zzcat-micropub"],
    );

    const filtered = await handler(
      new Request(`${MICROPUB}?q=category&filter=zzcat-indie`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(
      ((await filtered.json()) as { categories: string[] }).categories,
    ).toEqual(["zzcat-indieweb"]);

    const limited = await handler(
      new Request(`${MICROPUB}?q=category&filter=zzcat-&limit=1`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(
      ((await limited.json()) as { categories: string[] }).categories,
    ).toHaveLength(1);
  });

  it("q=category excludes a soft-deleted post's tags", async () => {
    const minted = await mintToken("create delete");
    const created = await createEntry(minted, {
      content: ["gone"],
      category: ["zzdel-ephemeral"],
    });
    const location = created.headers.get("location")!;
    await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({ action: "delete", url: location }),
      }),
      harness,
      ctx,
    );
    const res = await handler(
      new Request(`${MICROPUB}?q=category&filter=zzdel-ephemeral`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(((await res.json()) as { categories: string[] }).categories).toEqual(
      [],
    );
  });

  it("disabling the stable group hides q=category and skips vocabulary validation", async () => {
    const noStable = createMicropub({
      baseUrl: BASE,
      me: ME,
      extensions: { stable: false },
    });
    const minted = await mintToken("create");

    const cfg = await noStable(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(((await cfg.json()) as { q: string[] }).q).not.toContain("category");

    const cat = await noStable(
      new Request(`${MICROPUB}?q=category`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(cat.status).toBe(400);

    // With the group off, `post-status` is just an opaque property — no
    // validation, so an otherwise-rejected value is stored verbatim.
    const created = await createEntry(
      minted,
      { content: ["x"], "post-status": ["bogus"] },
      noStable,
    );
    expect(created.status).toBe(201);
  });
});

describe("@dwk/micropub proposed audience and location visibility", () => {
  const proposedHandler = createMicropub({
    baseUrl: BASE,
    me: ME,
    extensions: { proposed: true },
    audiences: [
      { uid: "family", name: "Family" },
      { uid: "project-alpha", name: "Project Alpha" },
    ],
  });

  async function createEntry(
    minted: MintedToken,
    properties: Record<string, unknown[]>,
  ): Promise<Response> {
    return proposedHandler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({ type: ["h-entry"], properties }),
      }),
      harness,
      ctx,
    );
  }

  it("advertises proposed properties and the configured named audiences", async () => {
    const minted = await mintToken("create");
    const res = await proposedHandler(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.properties).toEqual(["audience", "location-visibility"]);
    expect(body.audiences).toEqual([
      { uid: "family", name: "Family" },
      { uid: "project-alpha", name: "Project Alpha" },
    ]);
  });

  it("stores normalized audience and location-visibility metadata in source", async () => {
    const minted = await mintToken("create");
    const created = await createEntry(minted, {
      content: ["meet us there"],
      visibility: ["private"],
      audience: ["family", "family", "project-alpha"],
      location: ["The Park", "geo:45.5,-122.6"],
      "location-visibility": ["text"],
    });
    expect(created.status).toBe(201);
    const location = created.headers.get("location")!;
    const source = await proposedHandler(
      new Request(`${MICROPUB}?q=source&url=${encodeURIComponent(location)}`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const body = (await source.json()) as {
      properties: Record<string, unknown[]>;
    };
    expect(body.properties.audience).toEqual(["family", "project-alpha"]);
    expect(body.properties["location-visibility"]).toEqual(["text"]);
  });

  it("enforces configured private audiences and meaningful location disclosure", async () => {
    const minted = await mintToken("create");
    await expect(
      createEntry(minted, {
        visibility: ["private"],
        audience: ["unknown"],
      }),
    ).resolves.toHaveProperty("status", 400);
    await expect(
      createEntry(minted, { audience: ["family"] }),
    ).resolves.toHaveProperty("status", 400);
    await expect(
      createEntry(minted, { "location-visibility": ["text"] }),
    ).resolves.toHaveProperty("status", 400);
    await expect(
      createEntry(minted, {
        location: ["The Park"],
        "location-visibility": ["coordinates"],
      }),
    ).resolves.toHaveProperty("status", 400);
  });

  it("allows a private location on a public post for field-level redaction", async () => {
    const minted = await mintToken("create");
    const created = await createEntry(minted, {
      visibility: ["public"],
      location: ["The Park"],
      "location-visibility": ["private"],
    });
    expect(created.status).toBe(201);
  });

  it("validates the merged update result", async () => {
    const minted = await mintToken("create update");
    const created = await createEntry(minted, {
      visibility: ["private"],
      audience: ["family"],
    });
    const res = await proposedHandler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          action: "update",
          url: created.headers.get("location"),
          replace: { visibility: ["public"] },
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("keeps proposed property values opaque and unadvertised when disabled", async () => {
    const minted = await mintToken("create");
    const config = await handler(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect((await config.json()) as Record<string, unknown>).not.toHaveProperty(
      "audiences",
    );

    const created = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          type: ["h-entry"],
          properties: {
            audience: ["not-a-configured-audience"],
            "location-visibility": ["anything"],
          },
        }),
      }),
      harness,
      ctx,
    );
    expect(created.status).toBe(201);
  });
});

describe("@dwk/micropub DPoP htu binding behind a proxy", () => {
  it("binds htu to the configured endpoint, not request.url", async () => {
    // Path-rewriting proxy: the client signs the PUBLIC endpoint, but the
    // Worker sees a different internal request URL. The DPoP htu must be checked
    // against the configured endpoint — before this fix it used request.url and
    // failed htu_mismatch for exactly the mountable-prefix deployments targeted.
    const publicEndpoint = "https://public.example/micropub";
    const proxied = createMicropub({
      baseUrl: BASE,
      me: ME,
      micropubEndpoint: publicEndpoint,
    });
    const minted = await mintToken("create");
    const res = await proxied(
      new Request("https://internal.worker/micropub", {
        method: "POST",
        headers: {
          ...(await authHeaders(minted, "POST", publicEndpoint)),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "h=entry&content=proxied",
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(201);
  });
});

describe("@dwk/micropub proposed contacts", () => {
  it("advertises and manages private h-cards", async () => {
    const creator = await mintToken("create");
    const config = await contactsHandler(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(creator, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(((await config.json()) as { q: string[] }).q).toContain("contact");
    const created = await contactsHandler(
      new Request(`${MICROPUB}?q=contact`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(await authHeaders(creator, "POST", MICROPUB)),
        },
        body: new URLSearchParams({
          h: "card",
          name: "Ada Lovelace",
          url: "HTTPS://Ada.EXAMPLE:443",
          nickname: "ada",
        }),
      }),
      harness,
      ctx,
    );
    expect(created.status).toBe(201);
    const location = created.headers.get("location");
    const listed = await contactsHandler(
      new Request(`${MICROPUB}?q=contact&filter=ada`, {
        headers: await authHeaders(creator, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect((await listed.json()) as Record<string, unknown>).toMatchObject({
      contacts: [{ name: "Ada Lovelace", _internal_url: location }],
    });
    const deniedDelete = await contactsHandler(
      new Request(`${MICROPUB}?q=contact`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(await authHeaders(creator, "POST", MICROPUB)),
        },
        body: new URLSearchParams({ action: "delete", url: location ?? "" }),
      }),
      harness,
      ctx,
    );
    expect(deniedDelete.status).toBe(403);
    expect(((await deniedDelete.json()) as { error: string }).error).toBe(
      "insufficient_scope",
    );
    const mediaReader = await mintToken("media");
    const mediaScopedRead = await contactsHandler(
      new Request(`${MICROPUB}?q=contact`, {
        headers: await authHeaders(mediaReader, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(mediaScopedRead.status).toBe(200);
    const updater = await mintToken("update");
    const protectedMetadata = await contactsHandler(
      new Request(`${MICROPUB}?q=contact`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(updater, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          action: "update",
          url: location,
          replace: { _internal_url: ["forged"] },
        }),
      }),
      harness,
      ctx,
    );
    expect(protectedMetadata.status).toBe(400);
    const updated = await contactsHandler(
      new Request(`${MICROPUB}?q=contact`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(updater, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          action: "update",
          url: location,
          replace: { name: ["Ada King"] },
        }),
      }),
      harness,
      ctx,
    );
    expect(updated.status).toBe(204);
    const deleter = await mintToken("delete");
    const deleted = await contactsHandler(
      new Request(`${MICROPUB}?q=contact`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(await authHeaders(deleter, "POST", MICROPUB)),
        },
        body: new URLSearchParams({ action: "delete", url: location ?? "" }),
      }),
      harness,
      ctx,
    );
    expect(deleted.status).toBe(204);
  });

  it("folds an uploaded photo into a multipart contact create", async () => {
    const creator = await mintToken("create");
    const form = new FormData();
    form.set("h", "card");
    form.set("name", "Photo Contact");
    form.set(
      "photo",
      new File([new Uint8Array([8, 6, 7, 5, 3, 0, 9])], "photo.png", {
        type: "image/png",
      }),
    );
    const created = await contactsHandler(
      new Request(`${MICROPUB}?q=contact`, {
        method: "POST",
        headers: await authHeaders(creator, "POST", MICROPUB),
        body: form,
      }),
      harness,
      ctx,
    );
    expect(created.status).toBe(201);
    const listed = await contactsHandler(
      new Request(`${MICROPUB}?q=contact&filter=photo%20contact`, {
        headers: await authHeaders(creator, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const body = (await listed.json()) as {
      contacts: Array<{ photo?: string }>;
    };
    const photo = body.contacts[0]?.photo;
    expect(typeof photo).toBe("string");
    expect((photo as string).startsWith(`${MEDIA}/`)).toBe(true);
    const media = await contactsHandler(
      new Request(photo as string),
      harness,
      ctx,
    );
    expect(media.status).toBe(200);
  });

  it("rejects duplicate public URLs and malformed contact queries", async () => {
    const creator = await mintToken("create");
    const create = async (name: string, url: string): Promise<Response> =>
      contactsHandler(
        new Request(`${MICROPUB}?q=contact`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...(await authHeaders(creator, "POST", MICROPUB)),
          },
          body: new URLSearchParams({ h: "card", name, url }),
        }),
        harness,
        ctx,
      );
    expect((await create("Grace Hopper", "https://grace.example")).status).toBe(
      201,
    );
    expect(
      (await create("Grace Duplicate", "https://GRACE.example:443/")).status,
    ).toBe(409);
    const malformed = await contactsHandler(
      new Request(`${MICROPUB}?q=contact&limit=0`, {
        headers: await authHeaders(creator, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(malformed.status).toBe(400);
  });
});

describe("@dwk/micropub proposed venues (q=geo)", () => {
  it("advertises geo only when a venue store is configured", async () => {
    const reader = await mintToken("create");
    const withVenues = await venuesHandler(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(reader, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(((await withVenues.json()) as { q: string[] }).q).toContain("geo");
    const withoutVenues = await handler(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(reader, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(((await withoutVenues.json()) as { q: string[] }).q).not.toContain(
      "geo",
    );
  });

  it("returns nearby venues ordered by distance, with a geo suggestion", async () => {
    const reader = await mintToken("create");
    const suffix = crypto.randomUUID();
    await harness.MICROPUB_DB.prepare(
      `INSERT INTO micropub_venues
         (id, url, name, latitude, longitude, description, category, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
      .bind(
        `near-${suffix}`,
        `${BASE}/venues/near-${suffix}`,
        "Near Cafe",
        37.786971,
        -122.399677,
        1,
      )
      .run();
    await harness.MICROPUB_DB.prepare(
      `INSERT INTO micropub_venues
         (id, url, name, latitude, longitude, description, category, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
      .bind(
        `far-${suffix}`,
        `${BASE}/venues/far-${suffix}`,
        "Far Diner",
        40,
        -70,
        1,
      )
      .run();

    const res = await venuesHandler(
      new Request(`${MICROPUB}?q=geo&lat=37.786971&lon=-122.399677&u=500`, {
        headers: await authHeaders(reader, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      geo: { label: string; latitude: string; longitude: string };
      venues: Array<{
        name: string;
        url: string;
        latitude: string;
        longitude: string;
      }>;
    };
    expect(body.geo).toEqual({
      label: "37.786971, -122.399677",
      latitude: "37.786971",
      longitude: "-122.399677",
    });
    expect(body.venues).toEqual([
      {
        name: "Near Cafe",
        url: `${BASE}/venues/near-${suffix}`,
        latitude: "37.786971",
        longitude: "-122.399677",
      },
    ]);
  });

  it("rejects malformed q=geo queries with 400 invalid_request", async () => {
    const reader = await mintToken("create");
    const res = await venuesHandler(
      new Request(`${MICROPUB}?q=geo&lat=999&lon=0`, {
        headers: await authHeaders(reader, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });

  it("400s q=geo as an unsupported query when no venue store is configured", async () => {
    const reader = await mintToken("create");
    const res = await handler(
      new Request(`${MICROPUB}?q=geo&lat=0&lon=0`, {
        headers: await authHeaders(reader, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

// --- Proposed media-endpoint extensions ---------------------------------------

describe("@dwk/micropub media-endpoint extensions", () => {
  const mediaExt = createMicropub({
    baseUrl: BASE,
    me: ME,
    extensions: { proposed: true },
  });
  const mediaStore = createMicropubMediaStore(harness);

  beforeEach(async () => {
    await mediaStore.init();
    await harness.MICROPUB_DB.prepare("DELETE FROM micropub_media").run();
    // Empty the R2 bucket so listing/trash assertions are isolated.
    const listed = await harness.MEDIA.list();
    for (const object of listed.objects) await harness.MEDIA.delete(object.key);
  });

  async function upload(
    handlerFn: typeof handler,
    bytes: number[] = [1, 2, 3],
    type = "image/png",
  ): Promise<Response> {
    const minted = await mintToken("media");
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], "f", { type }));
    return handlerFn(
      new Request(MEDIA, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MEDIA),
        body: form,
      }),
      harness,
      ctx,
    );
  }

  async function mediaAction(
    scope: string,
    action: string,
    url: string,
    json = false,
  ): Promise<Response> {
    const minted = await mintToken(scope);
    const headers = await authHeaders(minted, "POST", MEDIA);
    const body = json
      ? JSON.stringify({ action, url })
      : new URLSearchParams({ action, url }).toString();
    return mediaExt(
      new Request(MEDIA, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": json
            ? "application/json"
            : "application/x-www-form-urlencoded",
        },
        body,
      }),
      harness,
      ctx,
    );
  }

  async function mediaQuery(
    scope: string,
    query: string,
    handlerFn: typeof handler = mediaExt,
  ): Promise<Response> {
    const minted = await mintToken(scope);
    return handlerFn(
      new Request(`${MEDIA}?${query}`, {
        headers: await authHeaders(minted, "GET", MEDIA),
      }),
      harness,
      ctx,
    );
  }

  // --- Disabled path stays byte-identical ------------------------------------

  it("keeps action=delete uninterpreted when the proposed group is off", async () => {
    const uploaded = await upload(handler);
    const url = uploaded.headers.get("location")!;
    const minted = await mintToken("delete media");
    const res = await handler(
      new Request(MEDIA, {
        method: "POST",
        headers: {
          ...(await authHeaders(minted, "POST", MEDIA)),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ action: "delete", url }).toString(),
      }),
      harness,
      ctx,
    );
    // Falls through to the existing missing-file 400; the blob survives.
    expect(res.status).toBe(400);
    expect((await handler(new Request(url), harness, ctx)).status).toBe(200);
  });

  it("keeps GET of the media endpoint a 405 when the proposed group is off", async () => {
    const res = await mediaQuery("media", "q=source", handler);
    expect(res.status).toBe(405);
  });

  it("keeps the upload response body empty when the proposed group is off", async () => {
    const res = await upload(handler);
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("");
  });

  it("omits the media-endpoint-extensions member from q=config by default", async () => {
    const minted = await mintToken("create");
    const res = await handler(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["media-endpoint-extensions"]).toBeUndefined();
  });

  it("records upload metadata even when the proposed group is off", async () => {
    const res = await upload(handler);
    const key = res.headers.get("location")!.slice(`${MEDIA}/`.length);
    const record = await mediaStore.get(key);
    expect(record?.contentType).toBe("image/png");
    expect(record?.sizeBytes).toBe(3);
  });

  it("still 201s a disabled-path upload when the metadata insert fails", async () => {
    await harness.MICROPUB_DB.prepare("DROP TABLE micropub_media").run();
    await harness.MICROPUB_DB.prepare(
      `CREATE TABLE micropub_media (
        key TEXT PRIMARY KEY CHECK (0),
        content_type TEXT, size_bytes INTEGER, uploaded_at INTEGER,
        deleted_at INTEGER
      )`,
    ).run();
    try {
      const res = await upload(handler);
      // Today's guarantee: a successful R2 write means a successful upload.
      expect(res.status).toBe(201);
      const url = res.headers.get("location")!;
      expect((await handler(new Request(url), harness, ctx)).status).toBe(200);
    } finally {
      await harness.MICROPUB_DB.prepare("DROP TABLE micropub_media").run();
      // A fresh store instance: the shared one memoizes its schema-ready
      // promise, so its init() would no-op against the dropped table.
      await createMicropubMediaStore(harness).init();
    }
  });

  it("500s an enabled-path upload and removes the blob when the metadata insert fails", async () => {
    await harness.MICROPUB_DB.prepare("DROP TABLE micropub_media").run();
    await harness.MICROPUB_DB.prepare(
      `CREATE TABLE micropub_media (
        key TEXT PRIMARY KEY CHECK (0),
        content_type TEXT, size_bytes INTEGER, uploaded_at INTEGER,
        deleted_at INTEGER
      )`,
    ).run();
    try {
      const res = await upload(mediaExt);
      // A URL handed to a client must always be both servable and listed.
      expect(res.status).toBe(500);
      expect((await harness.MEDIA.list()).objects.length).toBe(0);
    } finally {
      await harness.MICROPUB_DB.prepare("DROP TABLE micropub_media").run();
      // A fresh store instance: the shared one memoizes its schema-ready
      // promise, so its init() would no-op against the dropped table.
      await createMicropubMediaStore(harness).init();
    }
  });

  // --- Enabled: advertisement and upload body --------------------------------

  it("advertises the media-endpoint extensions in q=config when enabled", async () => {
    const minted = await mintToken("create");
    const res = await mediaExt(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["media-endpoint-extensions"]).toEqual({
      q: ["source"],
      actions: ["delete", "undelete"],
    });
  });

  it("adds the { url } JSON body to an enabled upload", async () => {
    const res = await upload(mediaExt);
    expect(res.status).toBe(201);
    const location = res.headers.get("location")!;
    expect((await res.json()) as { url: string }).toEqual({ url: location });
  });

  // --- Enabled: q=source at the media endpoint --------------------------------

  it("lists uploads newest-first with url, published, and mime_type", async () => {
    const first = await upload(mediaExt, [1], "image/png");
    const second = await upload(mediaExt, [2, 2], "image/jpeg");
    const firstUrl = first.headers.get("location")!;
    const secondUrl = second.headers.get("location")!;
    // Force distinct upload times for a deterministic order.
    await harness.MICROPUB_DB.prepare(
      "UPDATE micropub_media SET uploaded_at = uploaded_at + 10 WHERE key = ?",
    )
      .bind(secondUrl.slice(`${MEDIA}/`.length))
      .run();

    const res = await mediaQuery("media", "q=source");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { url: string; published: string; mime_type: string }[];
    };
    expect(body.items.map((item) => item.url)).toEqual([secondUrl, firstUrl]);
    expect(body.items[0]!.mime_type).toBe("image/jpeg");
    // RFC 3339 with no fractional seconds.
    expect(body.items[0]!.published).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  });

  it("paginates the media listing with limit and offset", async () => {
    await upload(mediaExt, [1]);
    await upload(mediaExt, [2]);
    const res = await mediaQuery("media", "q=source&limit=1&offset=1");
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBe(1);
  });

  it("requires the media scope for the media listing", async () => {
    const res = await mediaQuery("create", "q=source");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "insufficient_scope",
    );
  });

  it("rejects unknown media q=source parameters", async () => {
    const res = await mediaQuery("media", "q=source&nope=1");
    expect(res.status).toBe(400);
  });

  it("400s an unknown q at the enabled media endpoint", async () => {
    const res = await mediaQuery("media", "q=bogus");
    expect(res.status).toBe(400);
  });

  it("returns a single media object by url", async () => {
    const uploaded = await upload(mediaExt, [7, 7], "image/png");
    const url = uploaded.headers.get("location")!;
    const res = await mediaQuery(
      "media",
      `q=source&url=${encodeURIComponent(url)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; mime_type: string };
    expect(body.url).toBe(url);
    expect(body.mime_type).toBe("image/png");
  });

  it("400s a by-url query for a foreign URL and 404s an unknown one", async () => {
    const foreign = await mediaQuery(
      "media",
      `q=source&url=${encodeURIComponent("https://evil.example.net/media/x")}`,
    );
    expect(foreign.status).toBe(400);
    const unknown = await mediaQuery(
      "media",
      `q=source&url=${encodeURIComponent(
        `${MEDIA}/6d9f2c3a-1b4e-4f5a-8c7d-0e1f2a3b4c5d.jpg`,
      )}`,
    );
    expect(unknown.status).toBe(404);
  });

  // --- Enabled: action=delete / action=undelete -------------------------------

  it("requires both delete and media scopes for action=delete", async () => {
    const uploaded = await upload(mediaExt);
    const url = uploaded.headers.get("location")!;
    for (const scope of ["media", "delete"]) {
      const res = await mediaAction(scope, "delete", url);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        "insufficient_scope",
      );
    }
  });

  it("soft-deletes media into the trash prefix and undeletes it back", async () => {
    const uploaded = await upload(mediaExt, [5, 5, 5], "image/png");
    const url = uploaded.headers.get("location")!;
    const key = url.slice(`${MEDIA}/`.length);

    const del = await mediaAction("delete media", "delete", url);
    expect(del.status).toBe(204);
    // Live blob gone, trash copy durable, listing empty, public GET 404.
    expect(await harness.MEDIA.get(key)).toBeNull();
    expect(await harness.MEDIA.get(`.trash/${key}`)).not.toBeNull();
    expect((await mediaExt(new Request(url), harness, ctx)).status).toBe(404);
    const listing = (await (await mediaQuery("media", "q=source")).json()) as {
      items: unknown[];
    };
    expect(listing.items.length).toBe(0);

    // Deleting already-deleted media is 404 (recoverable ≠ addressable).
    expect((await mediaAction("delete media", "delete", url)).status).toBe(404);

    const undel = await mediaAction("undelete media", "undelete", url);
    expect(undel.status).toBe(204);
    expect(await harness.MEDIA.get(key)).not.toBeNull();
    expect(await harness.MEDIA.get(`.trash/${key}`)).toBeNull();
    const relisted = (await (await mediaQuery("media", "q=source")).json()) as {
      items: { url: string }[];
    };
    expect(relisted.items.map((item) => item.url)).toEqual([url]);
  });

  it("accepts a JSON action=delete body", async () => {
    const uploaded = await upload(mediaExt);
    const url = uploaded.headers.get("location")!;
    const res = await mediaAction("delete media", "delete", url, true);
    expect(res.status).toBe(204);
  });

  it("404s undelete after the trash copy is gone (post-purge permanence)", async () => {
    const uploaded = await upload(mediaExt);
    const url = uploaded.headers.get("location")!;
    const key = url.slice(`${MEDIA}/`.length);
    await mediaAction("delete media", "delete", url);
    await harness.MEDIA.delete(`.trash/${key}`);
    const res = await mediaAction("undelete media", "undelete", url);
    expect(res.status).toBe(404);
  });

  it("resumes a mid-failure delete where the trash copy already exists", async () => {
    const uploaded = await upload(mediaExt, [9], "image/png");
    const url = uploaded.headers.get("location")!;
    const key = url.slice(`${MEDIA}/`.length);
    // Simulate a crash between the trash copy and the live delete.
    await harness.MEDIA.put(`.trash/${key}`, new Uint8Array([9]));
    const res = await mediaAction("delete media", "delete", url);
    expect(res.status).toBe(204);
    expect(await harness.MEDIA.get(key)).toBeNull();
    expect(await harness.MEDIA.get(`.trash/${key}`)).not.toBeNull();
  });

  it("rejects delete URLs outside the media endpoint before touching storage", async () => {
    for (const url of [
      "https://evil.example.net/media/6d9f2c3a-1b4e-4f5a-8c7d-0e1f2a3b4c5d.jpg",
      `${MEDIA}/.trash/6d9f2c3a-1b4e-4f5a-8c7d-0e1f2a3b4c5d.jpg`,
      `${MEDIA}/../secret`,
      "not-a-url",
    ]) {
      const res = await mediaAction("delete media", "delete", url);
      expect(res.status).toBe(400);
    }
  });

  it("404s a delete of never-uploaded media", async () => {
    const res = await mediaAction(
      "delete media",
      "delete",
      `${MEDIA}/6d9f2c3a-1b4e-4f5a-8c7d-0e1f2a3b4c5d.jpg`,
    );
    expect(res.status).toBe(404);
  });

  it("rejects an unknown media action", async () => {
    const res = await mediaAction("delete media", "destroy", `${MEDIA}/x`);
    expect(res.status).toBe(400);
  });

  it("never serves the trash prefix from the public GET route", async () => {
    const uploaded = await upload(mediaExt, [3], "image/png");
    const url = uploaded.headers.get("location")!;
    const key = url.slice(`${MEDIA}/`.length);
    await mediaAction("delete media", "delete", url);
    const res = await mediaExt(
      new Request(`${MEDIA}/.trash/${key}`),
      harness,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("records metadata for files folded out of a multipart create", async () => {
    const minted = await mintToken("create");
    const form = new FormData();
    form.set("h", "entry");
    form.set("content", "with a photo");
    form.set(
      "photo",
      new File([new Uint8Array([9, 9])], "p.jpg", { type: "image/jpeg" }),
    );
    const res = await mediaExt(
      new Request(MICROPUB, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MICROPUB),
        body: form,
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(201);
    const listing = (await (await mediaQuery("media", "q=source")).json()) as {
      items: { mime_type: string }[];
    };
    expect(listing.items.map((item) => item.mime_type)).toEqual(["image/jpeg"]);
  });

  it("prunes expired trash rows during media-endpoint writes", async () => {
    const uploaded = await upload(mediaExt);
    const url = uploaded.headers.get("location")!;
    const key = url.slice(`${MEDIA}/`.length);
    await mediaAction("delete media", "delete", url);
    // Age the deletion far past the 30-day retention default.
    await harness.MICROPUB_DB.prepare(
      "UPDATE micropub_media SET deleted_at = 1 WHERE key = ?",
    )
      .bind(key)
      .run();
    await upload(mediaExt);
    expect(await mediaStore.get(key)).toBeNull();
  });

  it("requires both undelete and media scopes for action=undelete", async () => {
    const uploaded = await upload(mediaExt);
    const url = uploaded.headers.get("location")!;
    await mediaAction("delete media", "delete", url);
    for (const scope of ["media", "undelete"]) {
      const res = await mediaAction(scope, "undelete", url);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        "insufficient_scope",
      );
    }
  });

  it("rolls back earlier files when a later fold's metadata insert fails", async () => {
    // Sabotage: the `.png` key (first file) inserts fine, the `.jpg` key
    // (second file) trips the CHECK — so the failure hits mid-loop with one
    // blob and row already committed.
    await harness.MICROPUB_DB.prepare("DROP TABLE micropub_media").run();
    await harness.MICROPUB_DB.prepare(
      `CREATE TABLE micropub_media (
        key TEXT PRIMARY KEY CHECK (key NOT LIKE '%.jpg'),
        content_type TEXT, size_bytes INTEGER, uploaded_at INTEGER,
        deleted_at INTEGER
      )`,
    ).run();
    try {
      const minted = await mintToken("create");
      const form = new FormData();
      form.set("h", "entry");
      form.set("content", "two photos");
      form.append(
        "photo[]",
        new File([new Uint8Array([1])], "a.png", { type: "image/png" }),
      );
      form.append(
        "photo[]",
        new File([new Uint8Array([2])], "b.jpg", { type: "image/jpeg" }),
      );
      const res = await mediaExt(
        new Request(MICROPUB, {
          method: "POST",
          headers: await authHeaders(minted, "POST", MICROPUB),
          body: form,
        }),
        harness,
        ctx,
      );
      // The create fails closed — and no blob or row from the failed request
      // survives, so nothing servable/listed outlives a post never created.
      expect(res.status).toBe(500);
      expect((await harness.MEDIA.list()).objects.length).toBe(0);
      const rows = await harness.MICROPUB_DB.prepare(
        "SELECT COUNT(*) AS n FROM micropub_media",
      ).first<{ n: number }>();
      expect(rows?.n).toBe(0);
    } finally {
      await harness.MICROPUB_DB.prepare("DROP TABLE micropub_media").run();
      // A fresh store instance: the shared one memoizes its schema-ready
      // promise, so its init() would no-op against the dropped table.
      await createMicropubMediaStore(harness).init();
    }
  });
});

describe("@dwk/micropub fediverse syndication", () => {
  it("does not block the create response on fediverse syndication", async () => {
    let resolveSyndication!: () => void;
    const syndicationBlocked = new Promise<void>((resolve) => {
      resolveSyndication = resolve;
    });
    const waited: Promise<unknown>[] = [];
    const waitCtx = {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
    } as unknown as ExecutionContext;

    const fediverseHandler = createMicropub({
      baseUrl: BASE,
      me: ME,
      fediverse: {
        publishUrl: "https://social.example/users/alice/publish",
        publishToken: "s3cret",
        fetch: async () => {
          await syndicationBlocked;
          return new Response("{}", { status: 201 });
        },
      },
    });

    const minted = await mintToken("create");
    const start = Date.now();
    const res = await fediverseHandler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await authHeaders(minted, "POST", MICROPUB)),
        },
        body: JSON.stringify({
          type: ["h-entry"],
          properties: {
            content: ["Hello fediverse"],
            "mp-syndicate-to": [FEDIVERSE_TARGET_UID],
          },
        }),
      }),
      harness,
      waitCtx,
    );
    const elapsed = Date.now() - start;

    expect(res.status).toBe(201);
    expect(elapsed).toBeLessThan(500);
    expect(waited).toHaveLength(1);

    resolveSyndication();
    await waited[0];
  });
});
