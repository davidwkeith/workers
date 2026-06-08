/**
 * Phase 2 end-to-end: the IndieWeb trio + stateless discovery packages mounted
 * into the host on the D1/R2/KV shims, exercised through real HTTP.
 *
 * This is both the acceptance test for the storage-shim MVP and the reference
 * composition a self-hoster copies: it wires `@dwk/indieauth`, `@dwk/micropub`,
 * `@dwk/webmention`, `@dwk/webfinger`, `@dwk/host-meta`, and `@dwk/vc` with
 * {@link assembleBindings} (SQLite + filesystem) and proves a self-hoster can
 * authenticate via IndieAuth, publish a post and upload media that lands on
 * disk, receive a Webmention (sync path), and resolve WebFinger/host-meta — all
 * without a Cloudflare runtime.
 *
 * @see spec/self-hosting.md §7.1–§7.3, §13
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWebfinger } from "@dwk/webfinger";
import { createHostMeta } from "@dwk/host-meta";
import {
  createIndieAuth,
  createIndieAuthStore,
  signAccessToken,
} from "@dwk/indieauth";
import { createMicropub, createMicropubStore } from "@dwk/micropub";
import { createWebmention } from "@dwk/webmention";
import { createVc } from "@dwk/vc";

import { createServer, type DwkServer } from "./server";
import { assembleBindings } from "./bindings";
import { QueueBroker } from "./shims/queue";
import type { FetchHandler, Mount } from "./config";

// The host reconstructs every request URL from the configured baseUrl (never the
// Host header), so handlers see this origin regardless of the real listen port —
// which is exactly what the DPoP `htu` and issuer/`me` checks below rely on.
const ORIGIN = "http://localhost";
const ME = "https://alice.example.com/";
const CLIENT_ID = "https://app.example.org/";
const TOKEN_SIGNING_KEY = "phase2-test-signing-key-0123456789abcdef";

// --- DPoP + token helpers (real ES256 signatures, mirroring the micropub suite)

function bytesToBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
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
  const canonical = JSON.stringify({
    crv: publicJwk.crv,
    kty: "EC",
    x: publicJwk.x,
    y: publicJwk.y,
  });
  return {
    privateKey: pair.privateKey,
    publicJwk,
    jkt: await sha256Base64url(canonical),
  };
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

interface MintedToken {
  token: string;
  key: DpopKey;
}

async function mintToken(
  env: Record<string, unknown>,
  scope: string,
): Promise<MintedToken> {
  const key = await makeDpopKey();
  const now = Math.floor(Date.now() / 1000);
  const minted = await signAccessToken(TOKEN_SIGNING_KEY, {
    issuer: ORIGIN,
    me: ME,
    clientId: CLIENT_ID,
    scope,
    jkt: key.jkt,
    lifetimeSeconds: 3600,
    now,
  });
  await createIndieAuthStore(env as never).recordToken({
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

/** Build `Authorization` + `DPoP` headers bound to a specific request URL. */
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

// --- Composition ------------------------------------------------------------

let server: DwkServer | null = null;
let base = "";
let env: Record<string, unknown> = {};
let dataDir = "";

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "dwk-phase2-"));

  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const vcSigningJwk = JSON.stringify(
    await crypto.subtle.exportKey("jwk", pair.privateKey),
  );

  env = assembleBindings({
    dataDir,
    d1: ["AUTH_DB", "MICROPUB_DB", "VC_STATUS_DB"],
    r2: ["MEDIA"],
    secrets: { TOKEN_SIGNING_KEY, VC_SIGNING_KEY: vcSigningJwk },
  });
  const broker = new QueueBroker();
  env.WEBMENTION_QUEUE = broker.producer("WEBMENTION_QUEUE");
  // Expose the broker for the receiver assertion (the consumer is Phase 3).
  (env as { __broker?: QueueBroker }).__broker = broker;

  // Stores whose schema the handlers expect to exist (they do not self-init).
  await createIndieAuthStore(env as never).init();
  await createMicropubStore(env as never).init();

  const mounts: Mount[] = [
    {
      name: "@dwk/webfinger",
      handler: createWebfinger({
        resources: {
          "acct:alice@localhost": {
            subject: "acct:alice@localhost",
            links: [
              {
                rel: "http://webfinger.net/rel/profile-page",
                href: `${ORIGIN}/alice`,
              },
            ],
          },
        },
      }) as unknown as FetchHandler,
      reservedPaths: ["/.well-known/webfinger"],
    },
    {
      name: "@dwk/host-meta",
      handler: createHostMeta({
        webfingerUrl: `${ORIGIN}/.well-known/webfinger`,
      }) as unknown as FetchHandler,
      reservedPaths: ["/.well-known/host-meta"],
    },
    {
      name: "@dwk/indieauth",
      handler: createIndieAuth({
        baseUrl: ORIGIN,
        approveAuthorization: async () => ({ me: ME }),
      }) as unknown as FetchHandler,
      reservedPaths: [
        "/.well-known/oauth-authorization-server",
        "/authorize",
        "/token",
        "/revocation",
      ],
      requires: ["AUTH_DB", "TOKEN_SIGNING_KEY"],
    },
    {
      name: "@dwk/micropub",
      handler: createMicropub({
        baseUrl: ORIGIN,
        me: ME,
        // The DPoP replay store is not part of the package's public surface;
        // proof verification (htm/htu/ath/jkt) is exercised regardless.
        checkDpopReplay: false,
      }) as unknown as FetchHandler,
      reservedPaths: ["/micropub", "/media"],
      requires: ["MICROPUB_DB", "AUTH_DB", "MEDIA", "TOKEN_SIGNING_KEY"],
    },
    {
      name: "@dwk/webmention",
      handler: createWebmention({
        baseUrl: ORIGIN,
      }) as unknown as FetchHandler,
      reservedPaths: ["/webmention"],
      requires: ["WEBMENTION_QUEUE"],
    },
    {
      name: "@dwk/vc",
      handler: createVc({
        baseUrl: ORIGIN,
        status: { enabled: true },
      }) as unknown as FetchHandler,
      reservedPaths: ["/credentials"],
      requires: ["VC_STATUS_DB", "VC_SIGNING_KEY"],
    },
  ];

  server = createServer({
    baseUrl: ORIGIN,
    dataDir,
    mounts,
    env,
  });
  const { port } = await server.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server?.close();
  server = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("Phase 2 — IndieWeb trio + discovery on the shims", () => {
  it("resolves WebFinger through the host", async () => {
    const res = await fetch(
      `${base}/.well-known/webfinger?resource=acct:alice@localhost`,
    );
    expect(res.status).toBe(200);
    const jrd = (await res.json()) as { subject: string };
    expect(jrd.subject).toBe("acct:alice@localhost");
  });

  it("serves host-meta with an lrdd link to WebFinger", async () => {
    const res = await fetch(`${base}/.well-known/host-meta`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("webfinger");
  });

  it("publishes IndieAuth server metadata", async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as {
      issuer: string;
      token_endpoint: string;
    };
    expect(meta.issuer).toBe(ORIGIN);
    expect(meta.token_endpoint).toBe(`${ORIGIN}/token`);
  });

  it("publishes a post via Micropub (authenticated, DPoP-bound)", async () => {
    const minted = await mintToken(env, "create");
    const res = await fetch(`${base}/micropub`, {
      method: "POST",
      headers: {
        ...(await authHeaders(minted, "POST", `${ORIGIN}/micropub`)),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams([
        ["h", "entry"],
        ["content", "Hello from the Node host"],
        ["mp-slug", "hello"],
      ]).toString(),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/hello`);
  });

  it("uploads media that lands on disk and serves it back", async () => {
    const minted = await mintToken(env, "media");
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([1, 2, 3, 4])], "photo.png", {
        type: "image/png",
      }),
    );
    const res = await fetch(`${base}/media`, {
      method: "POST",
      headers: await authHeaders(minted, "POST", `${ORIGIN}/media`),
      body: form,
    });
    expect(res.status).toBe(201);
    const location = res.headers.get("location");
    expect(location?.startsWith(`${ORIGIN}/media/`)).toBe(true);

    // The blob actually exists under the filesystem-R2 bucket.
    const onDisk = readdirSync(join(dataDir, "r2", "MEDIA"));
    expect(onDisk.length).toBeGreaterThan(0);

    // And it serves back through the host with its content type and bytes.
    const path = new URL(location as string).pathname;
    const got = await fetch(`${base}${path}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(Array.from(new Uint8Array(await got.arrayBuffer()))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("accepts a Webmention (sync path) and enqueues verification", async () => {
    const broker = (env as { __broker?: QueueBroker }).__broker;
    expect(broker?.pending("WEBMENTION_QUEUE")).toBe(0);
    const res = await fetch(`${base}/webmention`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        source: "https://example.org/post",
        target: `${ORIGIN}/hello`,
      }).toString(),
    });
    expect(res.status).toBe(202);
    // The receiver enqueued the job for the (Phase 3) verification consumer.
    expect(broker?.pending("WEBMENTION_QUEUE")).toBe(1);
  });

  it("mounts the VC status-list endpoint backed by SQLite", async () => {
    const res = await fetch(`${base}/credentials/status-lists/revocation`);
    // Reached the VC handler (JSON), not the host's text/plain fallback —
    // proving the reserved subtree dispatches to the mount.
    expect(res.headers.get("content-type")).toContain("json");
    expect([200, 404, 500]).toContain(res.status);
  });

  it("returns the host fallback for an unmounted path", async () => {
    const res = await fetch(`${base}/not-a-reserved-path`);
    expect(res.status).toBe(404);
  });
});
