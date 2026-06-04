import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createSolidPod,
  SolidPodLogEvent,
  type Logger,
  type Metrics,
  type SolidPodEnv,
} from "./index";

const testEnv = env as unknown as SolidPodEnv;

const ISSUER = "https://issuer.example";
const OWNER = "https://owner.example/profile#me";
const BOB = "https://bob.example/profile#me";
const TURTLE = "text/turtle";

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

// --- crypto fixtures (ES256 issuer key + per-agent DPoP keys) --------------

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

async function ecThumbprint(jwk: JsonWebKey): Promise<string> {
  return sha256b64url(
    JSON.stringify({ crv: jwk.crv, kty: "EC", x: jwk.x, y: jwk.y }),
  );
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
  readonly jti?: string;
}

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

interface Pod {
  readonly base: string;
  readonly logger: ReturnType<typeof captureLogger>;
  readonly metrics: ReturnType<typeof captureMetrics>;
  send(method: string, path: string, init?: ReqInit): Promise<Response>;
}

function freshPod(): Pod {
  const base = `https://${crypto.randomUUID()}.pod.example`;
  const logger = captureLogger();
  const metrics = captureMetrics();
  const handler = createSolidPod({
    baseUrl: base,
    issuer: ISSUER,
    audience: "solid",
    jwks: [issuerJwk],
    owner: OWNER,
    logger,
    metrics,
  });
  return {
    base,
    logger,
    metrics,
    async send(method, path, init) {
      const request = await podRequest(method, `${base}${path}`, init);
      return handler(request, testEnv, {} as ExecutionContext);
    },
  };
}

// --- tests -----------------------------------------------------------------

describe("@dwk/solid-pod edge-auth logging", () => {
  it("warns auth.rejected with a reason on a malformed token", async () => {
    const pod = freshPod();
    await pod.send("GET", "/doc", {
      headers: { authorization: "DPoP not.a.jwt" },
    });
    const rec = find(pod.logger.records, SolidPodLogEvent.AuthRejected);
    expect(rec?.level).toBe("warn");
    expect(rec?.fields).toMatchObject({ reason: "token_malformed" });
    expect(
      pod.metrics.counts.some((c) => c.event === SolidPodLogEvent.AuthRejected),
    ).toBe(true);
  });

  it("logs auth.accepted (info) with a sanitized agent host", async () => {
    const pod = freshPod();
    await pod.send("GET", "/doc", { webid: OWNER });
    const rec = find(pod.logger.records, SolidPodLogEvent.AuthAccepted);
    expect(rec?.level).toBe("info");
    expect(rec?.fields).toMatchObject({ agentHost: "owner.example" });
    // The full WebID (with its path/fragment) is never logged.
    expect(JSON.stringify(pod.logger.records)).not.toContain(OWNER);
  });
});

describe("@dwk/solid-pod authz logging (DO outcomes via the front door)", () => {
  it("warns wac.denied (403) and strips the internal outcome header", async () => {
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
    const res = await pod.send("GET", "/doc", {
      webid: "https://eve.example/card#me",
    });
    expect(res.status).toBe(403);
    // The DO→front-door signal must not leak to the client.
    expect(res.headers.get("x-solid-outcome")).toBeNull();
    const rec = find(pod.logger.records, SolidPodLogEvent.AccessDenied);
    expect(rec?.level).toBe("warn");
    expect(rec?.fields).toMatchObject({ method: "GET", status: 403 });
  });

  it("warns wac.denied (401) for an anonymous request to a protected resource", async () => {
    const pod = freshPod();
    await pod.send("PUT", "/secret", {
      webid: OWNER,
      body: "<#a> <#b> <#c> .",
      headers: { "content-type": TURTLE },
    });
    const res = await pod.send("GET", "/secret");
    expect(res.status).toBe(401);
    expect(
      find(pod.logger.records, SolidPodLogEvent.AccessDenied)?.fields,
    ).toMatchObject({ method: "GET", status: 401 });
  });

  it("warns dpop.replay_rejected when a write reuses a jti", async () => {
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
    expect(replay.headers.get("x-solid-outcome")).toBeNull();
    const rec = find(pod.logger.records, SolidPodLogEvent.ReplayRejected);
    expect(rec?.level).toBe("warn");
    expect(rec?.fields).toMatchObject({ method: "PUT" });
  });
});
