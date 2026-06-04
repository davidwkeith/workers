import { env } from "cloudflare:test";
import { createIndieAuth, type IndieAuthEnv } from "@dwk/indieauth";
import { describe, expect, it } from "vitest";

import { createMicropub, type MicropubEnv } from "./index";

/**
 * Composition-contract test: two endpoint packages (`@dwk/indieauth` and
 * `@dwk/micropub`) mounted behind ONE router, under distinct path prefixes,
 * sharing ONE unioned `Env`. This guards the contract the whole monorepo is
 * built around (`spec/composition-contract.md`) — that several `createX`
 * factories route side by side inside a single Worker without colliding.
 *
 * It lives in the micropub project because that package already depends on
 * `@dwk/indieauth` and the miniflare harness binds what both packages need
 * (`AUTH_DB`, `TOKEN_SIGNING_KEY`, `MEDIA`, `MICROPUB_DB`).
 */

const BASE = "https://example.com";
const ME = "https://alice.example.com/";
const ctx = {} as ExecutionContext;

// The composed Env is the union of every mounted package's fragment.
type ComposedEnv = IndieAuthEnv & MicropubEnv;
const harness = env as unknown as ComposedEnv;

const indieauth = createIndieAuth({
  baseUrl: `${BASE}/auth`,
  metadataEndpoint: `${BASE}/auth/meta`,
  authorizationEndpoint: `${BASE}/auth/authorize`,
  tokenEndpoint: `${BASE}/auth/token`,
  revocationEndpoint: `${BASE}/auth/revocation`,
  approveAuthorization: async () => ({ me: ME }),
});

const micropub = createMicropub({
  baseUrl: BASE,
  me: ME,
  micropubEndpoint: `${BASE}/mp/micropub`,
  mediaEndpoint: `${BASE}/mp/media`,
});

/** Mount the handlers under path prefixes and dispatch the first match. */
const mounts: { prefix: string; handler: typeof micropub }[] = [
  { prefix: "/auth", handler: indieauth },
  { prefix: "/mp", handler: micropub },
];

async function composed(
  request: Request,
  e: ComposedEnv,
  c: ExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  for (const mount of mounts) {
    if (pathname === mount.prefix || pathname.startsWith(`${mount.prefix}/`)) {
      return mount.handler(request, e, c);
    }
  }
  return new Response("Not Found", { status: 404 });
}

describe("composition: indieauth + micropub behind one router", () => {
  it("routes a request under /auth to the IndieAuth handler", async () => {
    const res = await composed(new Request(`${BASE}/auth/meta`), harness, ctx);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as {
      issuer: string;
      token_endpoint: string;
    };
    expect(meta.issuer).toBe(`${BASE}/auth`);
    expect(meta.token_endpoint).toBe(`${BASE}/auth/token`);
  });

  it("routes a request under /mp to the Micropub handler", async () => {
    const res = await composed(
      new Request(`${BASE}/mp/micropub`, { method: "OPTIONS" }),
      harness,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves both packages from the SAME unioned env object", async () => {
    // The exact same `harness` env drives both handlers — the composed Env is
    // the union of both fragments, with no per-package global lookups.
    const authRes = await composed(
      new Request(`${BASE}/auth/meta`),
      harness,
      ctx,
    );
    const mpRes = await composed(
      new Request(`${BASE}/mp/media`, { method: "OPTIONS" }),
      harness,
      ctx,
    );
    expect(authRes.status).toBe(200);
    expect(mpRes.status).toBe(204);
  });

  it("returns 404 for a path under neither mount", async () => {
    const res = await composed(new Request(`${BASE}/elsewhere`), harness, ctx);
    expect(res.status).toBe(404);
  });
});
