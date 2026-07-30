import { env } from "cloudflare:test";
import { signAccessToken, createIndieAuthStore } from "@dwk/indieauth";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createMicropub,
  MicropubLogEvent,
  type Logger,
  type Metrics,
  type MicropubEnv,
} from "./index.js";

const harness = env as unknown as MicropubEnv;

const BASE = "https://example.com";
const ME = "https://alice.example.com/";
const CLIENT_ID = "https://app.example.org/";
const MICROPUB = `${BASE}/micropub`;
const MEDIA = `${BASE}/media`;
const ctx = {} as ExecutionContext;

// --- capturing seams -------------------------------------------------------

type LogRecord = {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields?: { [k: string]: unknown };
};

function captureLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const push =
    (level: LogRecord["level"]) =>
    (event: string, fields?: { [k: string]: unknown }) =>
      records.push({ level, event, fields });
  return {
    records,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

type MetricRecord = { event: string; fields?: { [k: string]: unknown } };

function captureMetrics(): Metrics & { counts: MetricRecord[] } {
  const counts: MetricRecord[] = [];
  return {
    counts,
    count: (event, fields) => counts.push({ event, fields }),
    observe: () => {},
  };
}

const find = (records: LogRecord[], event: string) =>
  records.find((r) => r.event === event);

// --- crypto + token helpers (real ES256, no mocking) -----------------------

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
  const jkt = await sha256Base64url(
    JSON.stringify({
      crv: publicJwk.crv,
      kty: "EC",
      x: publicJwk.x,
      y: publicJwk.y,
    }),
  );
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
  const signingInput = `${bytesToBase64url(
    new TextEncoder().encode(JSON.stringify(header)),
  )}.${bytesToBase64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
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

function build() {
  const logger = captureLogger();
  const metrics = captureMetrics();
  const handler = createMicropub({ baseUrl: BASE, me: ME, logger, metrics });
  return { logger, metrics, handler };
}

beforeEach(async () => {
  await createIndieAuthStore(harness).init();
  await (await import("./store.js")).createMicropubStore(harness).init();
  await (await import("./replay.js")).createDpopReplayStore(harness).init();
});

describe("@dwk/micropub auth logging", () => {
  it("warns auth.rejected with the error reason on an unauthenticated request", async () => {
    const { logger, metrics, handler } = build();
    await handler(new Request(`${MICROPUB}?q=config`), harness, ctx);
    const rec = find(logger.records, MicropubLogEvent.AuthRejected);
    expect(rec?.level).toBe("warn");
    expect(rec?.fields).toMatchObject({ reason: "unauthorized", status: 401 });
    expect(
      metrics.counts.some((c) => c.event === MicropubLogEvent.AuthRejected),
    ).toBe(true);
  });

  it("never logs the bearer token", async () => {
    const { logger, handler } = build();
    const minted = await mintToken("create");
    await handler(
      new Request(`${MICROPUB}?q=config`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(JSON.stringify(logger.records)).not.toContain(minted.token);
  });
});

describe("@dwk/micropub action logging", () => {
  it("logs action.completed action=create on a successful create", async () => {
    const { logger, metrics, handler } = build();
    const minted = await mintToken("create");
    const res = await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          ...(await authHeaders(minted, "POST", MICROPUB)),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: ["h-entry"],
          properties: { content: ["hello"] },
        }),
      }),
      harness,
      ctx,
    );
    expect(res.status).toBe(201);
    const rec = find(logger.records, MicropubLogEvent.ActionCompleted);
    expect(rec?.level).toBe("info");
    expect(rec?.fields).toMatchObject({ action: "create" });
    expect(
      metrics.counts.find((c) => c.event === MicropubLogEvent.ActionCompleted)
        ?.fields,
    ).toMatchObject({ action: "create" });
  });

  it("warns request.rejected reason missing_type on a create without a type", async () => {
    const { logger, handler } = build();
    const minted = await mintToken("create");
    await handler(
      new Request(MICROPUB, {
        method: "POST",
        headers: {
          ...(await authHeaders(minted, "POST", MICROPUB)),
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: [], properties: { content: ["x"] } }),
      }),
      harness,
      ctx,
    );
    expect(
      find(logger.records, MicropubLogEvent.RequestRejected)?.fields,
    ).toMatchObject({ reason: "missing_type" });
  });

  it("warns request.rejected reason query_unsupported on an unknown query", async () => {
    const { logger, handler } = build();
    const minted = await mintToken("create");
    await handler(
      new Request(`${MICROPUB}?q=bogus`, {
        headers: await authHeaders(minted, "GET", MICROPUB),
      }),
      harness,
      ctx,
    );
    expect(
      find(logger.records, MicropubLogEvent.RequestRejected)?.fields,
    ).toMatchObject({ reason: "query_unsupported" });
  });
});

describe("@dwk/micropub media logging", () => {
  it("logs media.stored on a successful upload", async () => {
    const { logger, handler } = build();
    const minted = await mintToken("media");
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" }),
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
    const rec = find(logger.records, MicropubLogEvent.MediaStored);
    expect(rec?.level).toBe("info");
    expect(rec?.fields).toMatchObject({ contentType: "image/png" });
  });

  it("logs the D1 failure and does not leak its message to the client", async () => {
    const logger = captureLogger();
    const metrics = captureMetrics();
    const handler = createMicropub({
      baseUrl: BASE,
      me: ME,
      extensions: { proposed: true },
      logger,
      metrics,
    });

    const minted = await mintToken("media");
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array([1, 2, 3])], "test.jpg", {
        type: "image/jpeg",
      }),
    );

    // Wrap the real MICROPUB_DB to intercept and fail only for the media
    // metadata insert, letting other queries through
    const realDb = harness.MICROPUB_DB;
    let isMediaInsert = false;

    const wrappedDb: D1Database = {
      prepare: (sql: string) => {
        isMediaInsert = sql.includes("INSERT INTO micropub_media");
        if (isMediaInsert) {
          return {
            bind: () => ({
              run: () =>
                Promise.reject(
                  new Error("no such column: internal_col"),
                ),
              first: () =>
                Promise.reject(
                  new Error("no such column: internal_col"),
                ),
              all: () =>
                Promise.reject(
                  new Error("no such column: internal_col"),
                ),
            }),
            run: () =>
              Promise.reject(
                new Error("no such column: internal_col"),
              ),
            first: () =>
              Promise.reject(
                new Error("no such column: internal_col"),
              ),
            all: () =>
              Promise.reject(
                new Error("no such column: internal_col"),
              ),
          } as unknown as D1PreparedStatement;
        }
        return realDb.prepare(sql);
      },
      batch: (statements: any[]) => realDb.batch(statements),
      exec: (sql: string) => realDb.exec(sql),
    } as unknown as D1Database;

    const failingEnv = {
      ...harness,
      MICROPUB_DB: wrappedDb,
    };

    const res = await handler(
      new Request(MEDIA, {
        method: "POST",
        headers: await authHeaders(minted, "POST", MEDIA),
        body: form,
      }),
      failingEnv,
      ctx,
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error_description?: string };
    expect(body.error_description).not.toContain("internal_col");
    expect(body.error_description).not.toContain("no such column");

    const errorRec = find(logger.records, MicropubLogEvent.MediaMetadataFailed);
    expect(errorRec?.level).toBe("error");
    expect(errorRec?.fields).toMatchObject({
      reason: "no such column: internal_col",
    });
  });
});
