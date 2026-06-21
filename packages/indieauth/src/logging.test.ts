import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createIndieAuth,
  createIndieAuthStore,
  IndieAuthLogEvent,
  type IndieAuthConfig,
  type IndieAuthEnv,
  type Logger,
  type Metrics,
} from "./index.js";

const harness = env as unknown as IndieAuthEnv;

const BASE = "https://example.com";
const CLIENT_ID = "https://app.example.org/";
const REDIRECT_URI = "https://app.example.org/callback";
const ME = "https://alice.example.com/";
const CODE_VERIFIER =
  "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-dBjftJeZ4CVP-mB92K27";

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

// --- crypto helpers (real ES256, no mocking) -------------------------------

async function s256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return bytesToBase64url(new Uint8Array(digest));
}

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
  delete publicJwk.d;
  return { privateKey: pair.privateKey, publicJwk };
}

async function makeProof(
  key: DpopKey,
  htm: string,
  htu: string,
): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk };
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
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

// --- handler / request builders --------------------------------------------

function config(logger: Logger, metrics: Metrics): IndieAuthConfig {
  return {
    baseUrl: BASE,
    approveAuthorization: async () => ({ me: ME, profile: { name: "Alice" } }),
    logger,
    metrics,
  };
}

async function authorizeUrl(scope = "create update"): Promise<string> {
  const url = new URL(`${BASE}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", "xyz");
  url.searchParams.set("code_challenge", await s256(CODE_VERIFIER));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", scope);
  return url.toString();
}

const ctx = {} as ExecutionContext;

beforeEach(async () => {
  await createIndieAuthStore(harness).init();
});

describe("@dwk/indieauth authorization logging", () => {
  it("logs and counts authorize.approved on a successful request", async () => {
    const logger = captureLogger();
    const metrics = captureMetrics();
    const handler = createIndieAuth(config(logger, metrics));
    await handler(
      new Request(await authorizeUrl(), { redirect: "manual" }),
      harness,
      ctx,
    );
    const rec = find(logger.records, IndieAuthLogEvent.AuthorizeApproved);
    expect(rec?.level).toBe("info");
    expect(rec?.fields).toMatchObject({ clientHost: "app.example.org" });
    // The same (event, fields) is mirrored to the metrics seam.
    expect(
      metrics.counts.find(
        (c) => c.event === IndieAuthLogEvent.AuthorizeApproved,
      )?.fields,
    ).toMatchObject({ clientHost: "app.example.org" });
  });

  it("warns authorize.rejected with reason pkce_required when PKCE is absent", async () => {
    const logger = captureLogger();
    const metrics = captureMetrics();
    const handler = createIndieAuth(config(logger, metrics));
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("state", "s");
    await handler(
      new Request(url.toString(), { redirect: "manual" }),
      harness,
      ctx,
    );
    const rec = find(logger.records, IndieAuthLogEvent.AuthorizeRejected);
    expect(rec?.level).toBe("warn");
    expect(rec?.fields).toMatchObject({ reason: "pkce_required" });
    expect(
      metrics.counts.some(
        (c) => c.event === IndieAuthLogEvent.AuthorizeRejected,
      ),
    ).toBe(true);
  });

  it("warns reason redirect_uri_not_permitted for a cross-origin redirect", async () => {
    const logger = captureLogger();
    const metrics = captureMetrics();
    const handler = createIndieAuth(config(logger, metrics));
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", "https://evil.example/cb");
    url.searchParams.set("code_challenge", await s256(CODE_VERIFIER));
    url.searchParams.set("code_challenge_method", "S256");
    await handler(
      new Request(url.toString(), { redirect: "manual" }),
      harness,
      ctx,
    );
    expect(
      find(logger.records, IndieAuthLogEvent.AuthorizeRejected)?.fields,
    ).toMatchObject({ reason: "redirect_uri_not_permitted" });
  });
});

describe("@dwk/indieauth token logging", () => {
  async function getCode(handler: ReturnType<typeof createIndieAuth>) {
    const res = await handler(
      new Request(await authorizeUrl(), { redirect: "manual" }),
      harness,
      ctx,
    );
    return new URL(res.headers.get("location")!).searchParams.get("code")!;
  }

  it("logs token.issued (info) and never logs secrets", async () => {
    const logger = captureLogger();
    const metrics = captureMetrics();
    const handler = createIndieAuth(config(logger, metrics));
    const code = await getCode(handler);
    const key = await makeDpopKey();
    await handler(
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
    const rec = find(logger.records, IndieAuthLogEvent.TokenIssued);
    expect(rec?.level).toBe("info");
    expect(rec?.fields).toMatchObject({
      clientHost: "app.example.org",
      scope: "create update",
    });
    // No record anywhere carries the code, verifier, or an access token.
    const serialized = JSON.stringify(logger.records);
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain(CODE_VERIFIER);
    expect(serialized).not.toContain("access_token");
  });

  it("warns token.rejected reason dpop_missing when no proof is presented", async () => {
    const logger = captureLogger();
    const metrics = captureMetrics();
    const handler = createIndieAuth(config(logger, metrics));
    const code = await getCode(handler);
    await handler(
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
    expect(
      find(logger.records, IndieAuthLogEvent.TokenRejected)?.fields,
    ).toMatchObject({ reason: "dpop_missing" });
  });

  it("warns token.rejected reason pkce_failed on a wrong verifier", async () => {
    const logger = captureLogger();
    const metrics = captureMetrics();
    const handler = createIndieAuth(config(logger, metrics));
    const code = await getCode(handler);
    const key = await makeDpopKey();
    await handler(
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
    expect(
      find(logger.records, IndieAuthLogEvent.TokenRejected)?.fields,
    ).toMatchObject({ reason: "pkce_failed" });
  });

  it("logs token.revoked (info) at the revocation endpoint", async () => {
    const logger = captureLogger();
    const metrics = captureMetrics();
    const handler = createIndieAuth(config(logger, metrics));
    const code = await getCode(handler);
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
    await handler(
      new Request(`${BASE}/revocation`, {
        method: "POST",
        body: new URLSearchParams({ token: access_token }),
      }),
      harness,
      ctx,
    );
    expect(find(logger.records, IndieAuthLogEvent.TokenRevoked)?.level).toBe(
      "info",
    );
  });
});
