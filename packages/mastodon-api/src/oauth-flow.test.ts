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
