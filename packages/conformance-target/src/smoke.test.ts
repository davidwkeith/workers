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

describe("IndieWeb endpoints", () => {
  it("micropub config query requires a token", async () => {
    const res = await call("/micropub?q=config");
    expect(res.status).toBe(401);
  });

  it("microsub requires a token", async () => {
    const res = await call("/microsub?action=channels");
    expect(res.status).toBe(401);
  });

  it("webmention rejects a mention without source/target", async () => {
    const res = await call("/webmention", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "source=",
    });
    expect(res.status).toBe(400);
  });

  it("webmention accepts a well-formed mention for our origin", async () => {
    const res = await call("/webmention", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        source: "https://sender.example/post",
        target: `${BASE}/`,
      }).toString(),
    });
    // Async verification via WEBMENTION_QUEUE: the spec allows 201 (status
    // resource created) or 202 (accepted for processing).
    expect([201, 202]).toContain(res.status);
  });

  it("websub rejects a subscription for a foreign topic", async () => {
    const res = await call("/websub", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.topic": "https://evil.example/feed",
        "hub.callback": "https://subscriber.example/cb",
      }).toString(),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("storage and identity endpoints", () => {
  it("solid pod denies an anonymous read", async () => {
    const res = await call("/pod/");
    // Owner-only default ACL. If the package's default makes the pod root
    // public-readable (check its handler tests), change this to 200.
    expect(res.status).toBe(401);
  });

  it("solid pod admits the admin bearer as owner", async () => {
    const res = await call("/pod/", {
      headers: { authorization: "Bearer conformance-test-admin-token" },
    });
    // Deviation from the brief: the owner bypasses WAC entirely (no 401/403),
    // but the pod root container is lazily materialized — on a freshly
    // provisioned pod with nothing ever written, `store.head("/")` finds
    // nothing and `#read` 404s even for the owner (see
    // packages/solid-pod/src/pod.ts `#read`, and the LDP suite's root-GET
    // test at packages/solid-pod/src/index.test.ts:1415, which only gets 200
    // after a prior POST creates a child). 404 here proves WAC let the owner
    // through (not a 401/403 auth denial); it is not "not implemented".
    expect(res.status).toBe(404);
  });

  it("webdav door challenges with Basic", async () => {
    const res = await call("/dav/", { method: "PROPFIND" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain("Basic");
  });

  it("mints an app password and writes through the WebDAV door", async () => {
    const mint = await call("/dav-credentials", {
      method: "POST",
      headers: {
        authorization: "Bearer conformance-test-admin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        label: "smoke",
        scope: { modes: ["read", "write"] },
      }),
    });
    expect(mint.status).toBe(201);
    const cred = (await mint.json()) as { username: string; secret: string };
    const put = await call("/dav/smoke.txt", {
      method: "PUT",
      headers: {
        authorization: `Basic ${btoa(`${cred.username}:${cred.secret}`)}`,
        "content-type": "text/plain",
      },
      body: "hello",
    });
    expect(put.status).toBe(201);
  });

  it("remotestorage denies an anonymous private read", async () => {
    const res = await call("/storage/conformance/notes/today");
    expect(res.status).toBe(401);
  });

  it("webauthn registration options endpoint is mounted", async () => {
    const res = await call("/webauthn/register/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "conformance" }),
    });
    expect(res.status).not.toBe(404);
    expect(res.status).toBeLessThan(500);
  });

  it("vc verify endpoint is mounted", async () => {
    const res = await call("/credentials/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).not.toBe(404);
    expect(res.status).toBeLessThan(500);
  });

  it("serves the ActivityPub actor document", async () => {
    const res = await call("/users/conformance", {
      headers: { accept: "application/activity+json" },
    });
    expect(res.status).toBe(200);
    const actor = (await res.json()) as { preferredUsername: string };
    expect(actor.preferredUsername).toBe("conformance");
  });

  it("serves nodeinfo discovery", async () => {
    const res = await call("/.well-known/nodeinfo");
    expect(res.status).toBe(200);
  });

  it("serves the atproto DID binding", async () => {
    const res = await call("/.well-known/atproto-did");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("did:web:conformance.test");
  });
});

describe("queue and scheduled handlers", () => {
  function emptyBatch(queue: string): MessageBatch<never> {
    return {
      queue,
      messages: [],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<never>;
  }

  it("dispatches known queues and rejects unknown ones", async () => {
    const ctx = createExecutionContext();
    await expect(
      worker.queue(emptyBatch("conformance-webmention"), testEnv, ctx),
    ).resolves.toBeUndefined();
    await expect(
      worker.queue(emptyBatch("conformance-websub"), testEnv, ctx),
    ).resolves.toBeUndefined();
    await expect(
      worker.queue(emptyBatch("conformance-microsub"), testEnv, ctx),
    ).resolves.toBeUndefined();
    await expect(
      worker.queue(emptyBatch("no-such-queue"), testEnv, ctx),
    ).rejects.toThrow(/unknown queue/);
  });

  it("runs the shared GC pass", async () => {
    const controller = {
      scheduledTime: Date.now(),
      cron: "*/15 * * * *",
      noRetry() {},
    } as unknown as ScheduledController;
    await expect(
      worker.scheduled(controller, testEnv, createExecutionContext()),
    ).resolves.toBeUndefined();
  });
});
