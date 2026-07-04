/**
 * Per-mount smoke tests: every mounted package answers its cheapest request
 * (spec: "composition regressions are caught by ordinary pnpm test"). These
 * assert reachability + the protocol-certain response, not protocol depth —
 * that lives in each package's own tests.
 */

import { createIndieAuthStore } from "@dwk/indieauth";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { ConformanceEnv } from "./index.js";
import worker from "./index.js";

const testEnv = env as unknown as ConformanceEnv;
const BASE = "https://conformance.test";

// A real deployment creates the AUTH_DB schema at deploy time; the test
// harness does it here via the package's public (idempotent) store API.
beforeAll(async () => {
  await createIndieAuthStore(testEnv).init();
});

function call(path: string, init?: RequestInit): Promise<Response> {
  // `worker.fetch` is typed via `ExportedHandler`, which expects the
  // Workers-runtime `IncomingRequestCfProperties`; a plain test `Request` has
  // no `cf` object at all. The mismatch is type-only — workerd supplies `cf`
  // at runtime regardless — so assert through `unknown`.
  const request = new Request(`${BASE}${path}`, init) as unknown as Parameters<
    typeof worker.fetch
  >[0];
  return worker.fetch(request, testEnv, createExecutionContext());
}

describe("home", () => {
  it("serves the h-card identity page with endpoint discovery links", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('class="h-card"');
    expect(body).toContain('rel="micropub"');
    expect(body).toContain('rel="webmention"');
    expect(body).toContain('rel="authorization_endpoint"');
  });

  it("serves the owner WebID profile document as Turtle", async () => {
    const res = await call("/profile/card");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/turtle");
    expect(await res.text()).toContain("#me");
  });

  it("404s unmounted paths", async () => {
    const res = await call("/no-such-mount");
    expect(res.status).toBe(404);
  });
});

describe("discovery", () => {
  it("webfinger resolves the test acct: resource", async () => {
    const res = await call(
      "/.well-known/webfinger?resource=acct:conformance@conformance.test",
    );
    expect(res.status).toBe(200);
    const jrd = (await res.json()) as { subject: string };
    expect(jrd.subject).toBe("acct:conformance@conformance.test");
  });

  it("host-meta advertises the lrdd template", async () => {
    const res = await call("/.well-known/host-meta");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("lrdd");
  });
});

describe("@dwk/indieauth", () => {
  it("serves OAuth server metadata with the deployment issuer", async () => {
    const res = await call("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { issuer: string };
    expect(meta.issuer).toBe(BASE);
  });

  it("rejects an authorization request without client_id", async () => {
    const res = await call("/authorize");
    expect(res.status).toBe(400);
  });

  it("renders the consent form for a well-formed authorization request", async () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "https://app.example/",
      redirect_uri: "https://app.example/callback",
      state: "s1",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    const res = await call(`/authorize?${params}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="password"');
  });

  /** The consent form's fields: the authorization params plus the password. */
  function consentBody(password: string): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: "https://app.example/",
        redirect_uri: "https://app.example/callback",
        state: "s1",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        password,
      }).toString(),
    };
  }

  it("rejects a consent submission with the wrong password", async () => {
    const res = await call("/consent", consentBody("wrong-password"));
    expect(res.status).toBe(403);
  });

  it("redirects an approved consent back to /authorize with a signed token", async () => {
    const res = await call(
      "/consent",
      consentBody("conformance-test-password"),
    );
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/authorize");
    expect(location.searchParams.get("consent_sig")).toBeTruthy();
    expect(location.searchParams.get("consent_exp")).toBeTruthy();
  });

  it("completes the consent dance with an authorization code", async () => {
    const consent = await call(
      "/consent",
      consentBody("conformance-test-password"),
    );
    expect(consent.status).toBe(303);
    const back = new URL(consent.headers.get("location") ?? "");

    const authorized = await call(`${back.pathname}${back.search}`);
    expect(authorized.status).toBe(302);
    const redirect = new URL(authorized.headers.get("location") ?? "");
    expect(`${redirect.origin}${redirect.pathname}`).toBe(
      "https://app.example/callback",
    );
    expect(redirect.searchParams.get("code")).toBeTruthy();
    expect(redirect.searchParams.get("state")).toBe("s1");
  });
});
