import { beforeEach, describe, expect, it } from "vitest";

import type { MastodonApiConfig } from "./config.js";
import { sha256Hex } from "./encoding.js";
import { createMastodonStore } from "./store.js";
import {
  api,
  registerApp,
  resetDb,
  testConfig,
  testEnv,
} from "./test-harness.js";

const OOB = "urn:ietf:wg:oauth:2.0:oob";

function authorizeUrl(params: Record<string, string>): string {
  const url = new URL("https://owner.example/oauth/authorize");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

describe("GET /oauth/authorize", () => {
  beforeEach(resetDb);

  it("400s an unknown client_id without redirecting", async () => {
    const res = await api()(
      new Request(
        authorizeUrl({
          client_id: "unknown",
          redirect_uri: "app://cb",
          response_type: "code",
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/client/i);
  });

  it("400s an unregistered redirect_uri without redirecting", async () => {
    const app = await registerApp();
    const res = await api()(
      new Request(
        authorizeUrl({
          client_id: app.client_id,
          redirect_uri: "https://evil.example/cb",
          response_type: "code",
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it("redirects errors the client can handle (bad response_type)", async () => {
    const app = await registerApp();
    const res = await api()(
      new Request(
        authorizeUrl({
          client_id: app.client_id,
          redirect_uri: "app://oauth-callback",
          response_type: "token",
          state: "xyz",
        }),
      ),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe(
      "unsupported_response_type",
    );
    expect(location.searchParams.get("state")).toBe("xyz");
  });

  it("returns the approval hook's Response unchanged", async () => {
    const app = await registerApp();
    const consent: MastodonApiConfig = {
      ...testConfig,
      approveAuthorization: async () =>
        new Response("<form>consent</form>", {
          headers: { "content-type": "text/html" },
        }),
    };
    const res = await api(consent)(
      new Request(
        authorizeUrl({
          client_id: app.client_id,
          redirect_uri: "app://oauth-callback",
          response_type: "code",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("consent");
  });

  it("mints a redeemable code bound to the grant on approval", async () => {
    const app = await registerApp();
    const res = await api()(
      new Request(
        authorizeUrl({
          client_id: app.client_id,
          redirect_uri: "app://oauth-callback",
          response_type: "code",
          scope: "read write",
          state: "abc",
        }),
      ),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.protocol).toBe("app:");
    const code = location.searchParams.get("code") ?? "";
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("state")).toBe("abc");

    const record = await createMastodonStore(testEnv).redeemCode(
      code,
      Math.floor(Date.now() / 1000),
    );
    expect(record).not.toBeNull();
    expect(record?.clientId).toBe(app.client_id);
    expect(record?.redirectUri).toBe("app://oauth-callback");
    expect(record?.scope).toBe("read write");
    expect(record?.codeChallenge).toBeNull();
  });

  it("defaults scope to the app's registered scopes", async () => {
    const app = await registerApp();
    const res = await api()(
      new Request(
        authorizeUrl({
          client_id: app.client_id,
          redirect_uri: "app://oauth-callback",
          response_type: "code",
        }),
      ),
    );
    const code =
      new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const record = await createMastodonStore(testEnv).redeemCode(
      code,
      Math.floor(Date.now() / 1000),
    );
    expect(record?.scope).toBe("read write follow push");
  });

  it("records an S256 PKCE challenge and rejects plain", async () => {
    const app = await registerApp();
    const challenge = await sha256Hex("ignored"); // any string works as a stored challenge
    const res = await api()(
      new Request(
        authorizeUrl({
          client_id: app.client_id,
          redirect_uri: "app://oauth-callback",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
      ),
    );
    const code =
      new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const record = await createMastodonStore(testEnv).redeemCode(
      code,
      Math.floor(Date.now() / 1000),
    );
    expect(record?.codeChallenge).toBe(challenge);

    const plain = await api()(
      new Request(
        authorizeUrl({
          client_id: app.client_id,
          redirect_uri: "app://oauth-callback",
          response_type: "code",
          code_challenge: "whatever",
          code_challenge_method: "plain",
          state: "s",
        }),
      ),
    );
    expect(plain.status).toBe(302);
    const location = new URL(plain.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("invalid_request");
  });

  it("renders the code on an oob redirect_uri", async () => {
    const app = await registerApp({ redirect_uris: OOB });
    const res = await api()(
      new Request(
        authorizeUrl({
          client_id: app.client_id,
          redirect_uri: OOB,
          response_type: "code",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    const match = /<title>([A-Za-z0-9_-]{43})<\/title>/.exec(html);
    expect(match).not.toBeNull();
    expect(html).toContain(match?.[1] ?? "@@nope@@");
  });
});

/** Drive authorize and pull the minted code off the redirect. */
async function obtainCode(
  app: { client_id: string },
  extra: Record<string, string> = {},
): Promise<string> {
  const res = await api()(
    new Request(
      authorizeUrl({
        client_id: app.client_id,
        redirect_uri: "app://oauth-callback",
        response_type: "code",
        scope: "read write",
        ...extra,
      }),
    ),
  );
  const code = new URL(res.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  if (!code) throw new Error("authorize did not mint a code");
  return code;
}

interface TokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly scope: string;
  readonly created_at: number;
}

function tokenRequest(fields: Record<string, string>): Request {
  return new Request("https://owner.example/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("POST /oauth/token", () => {
  beforeEach(resetDb);

  it("exchanges a code for a bearer token (hashed at rest, owner-bound)", async () => {
    const app = await registerApp();
    const code = await obtainCode(app);
    const res = await api()(
      tokenRequest({
        grant_type: "authorization_code",
        client_id: app.client_id,
        client_secret: app.client_secret,
        redirect_uri: "app://oauth-callback",
        code,
      }),
    );
    expect(res.status).toBe(200);
    const token = (await res.json()) as TokenResponse;
    expect(token.token_type).toBe("Bearer");
    expect(token.scope).toBe("read write");
    expect(token.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.created_at).toBeGreaterThan(1_700_000_000);

    const stored = await createMastodonStore(testEnv).getToken(
      await sha256Hex(token.access_token),
    );
    expect(stored).not.toBeNull();
    expect(stored?.accountId).toBe("1");
    expect(stored?.clientId).toBe(app.client_id);
  });

  it("rejects a replayed code", async () => {
    const app = await registerApp();
    const code = await obtainCode(app);
    const fields = {
      grant_type: "authorization_code",
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: "app://oauth-callback",
      code,
    };
    expect((await api()(tokenRequest(fields))).status).toBe(200);
    const replay = await api()(tokenRequest(fields));
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  it("rejects a wrong client_secret with 401", async () => {
    const app = await registerApp();
    const code = await obtainCode(app);
    const res = await api()(
      tokenRequest({
        grant_type: "authorization_code",
        client_id: app.client_id,
        client_secret: "wrong",
        redirect_uri: "app://oauth-callback",
        code,
      }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_client",
    );
  });

  it("rejects a mismatched redirect_uri", async () => {
    const app = await registerApp({
      redirect_uris: "app://oauth-callback\napp://other",
    });
    const code = await obtainCode(app);
    const res = await api()(
      tokenRequest({
        grant_type: "authorization_code",
        client_id: app.client_id,
        client_secret: app.client_secret,
        redirect_uri: "app://other",
        code,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("verifies PKCE when a challenge was recorded", async () => {
    const app = await registerApp();
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const good = await obtainCode(app, {
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const ok = await api()(
      tokenRequest({
        grant_type: "authorization_code",
        client_id: app.client_id,
        client_secret: app.client_secret,
        redirect_uri: "app://oauth-callback",
        code: good,
        code_verifier: verifier,
      }),
    );
    expect(ok.status).toBe(200);

    const bad = await obtainCode(app, {
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const rejected = await api()(
      tokenRequest({
        grant_type: "authorization_code",
        client_id: app.client_id,
        client_secret: app.client_secret,
        redirect_uri: "app://oauth-callback",
        code: bad,
        code_verifier: "not-the-verifier-at-all-not-the-verifier-at",
      }),
    );
    expect(rejected.status).toBe(400);
  });

  it("supports client_credentials with an account-less token", async () => {
    const app = await registerApp();
    const res = await api()(
      tokenRequest({
        grant_type: "client_credentials",
        client_id: app.client_id,
        client_secret: app.client_secret,
      }),
    );
    expect(res.status).toBe(200);
    const token = (await res.json()) as TokenResponse;
    const stored = await createMastodonStore(testEnv).getToken(
      await sha256Hex(token.access_token),
    );
    expect(stored?.accountId).toBeNull();
  });

  it("accepts HTTP Basic client authentication", async () => {
    const app = await registerApp();
    const res = await api()(
      new Request("https://owner.example/oauth/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa(
            `${app.client_id}:${app.client_secret}`,
          )}`,
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts a JSON body", async () => {
    const app = await registerApp();
    const code = await obtainCode(app);
    const res = await api()(
      new Request("https://owner.example/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: app.client_id,
          client_secret: app.client_secret,
          redirect_uri: "app://oauth-callback",
          code,
        }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects unsupported grant types", async () => {
    const app = await registerApp();
    const res = await api()(
      tokenRequest({
        grant_type: "password",
        client_id: app.client_id,
        client_secret: app.client_secret,
        username: "owner",
        password: "hunter2",
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unsupported_grant_type",
    );
  });
});
