/**
 * Per-mount smoke tests: every mounted package answers its cheapest request
 * (spec: "composition regressions are caught by ordinary pnpm test"). These
 * assert reachability + the protocol-certain response, not protocol depth —
 * that lives in each package's own tests.
 */

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ConformanceEnv } from "./index.js";
import worker from "./index.js";

const testEnv = env as unknown as ConformanceEnv;
const BASE = "https://conformance.test";

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
