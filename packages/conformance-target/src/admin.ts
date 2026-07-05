/**
 * `POST /admin/init` — one-time D1 schema initialization for a freshly
 * deployed target. Real traffic never hits this: an operator calls it once
 * after `wrangler deploy` (see README.md), before the first suite run,
 * because a fresh D1 database has no tables yet (the IndieAuth consent flow
 * 500s without `AUTH_DB`'s schema, for example).
 *
 * Only packages with a **public** D1-store init API are called here
 * (`createIndieAuthStore`, `createMicropubStore`, `createMicrosubStore`) —
 * `@dwk/websub` and `@dwk/webmention` create their schema lazily on first
 * store operation instead, so they have nothing to call and are reported as
 * "unavailable". This never reaches into a package's internals.
 *
 * Gated by a shared-secret bearer (`CONFORMANCE_ADMIN_TOKEN`, the same
 * interim credential the pods use — see config.ts) rather than left open,
 * since it can rerun schema migrations. Idempotent: every underlying `init()`
 * is `CREATE TABLE IF NOT EXISTS`.
 */

import { createIndieAuthStore } from "@dwk/indieauth";
import { createMicropubStore } from "@dwk/micropub";
import { createMicrosubStore } from "@dwk/microsub";

import type { ConformanceEnv } from "./config.js";

const UNAVAILABLE_PACKAGES = {
  "@dwk/websub":
    "no public D1 init API — schema is created lazily on first use",
  "@dwk/webmention":
    "no public D1 init API — schema is created lazily on first use",
} as const;

/**
 * Build the `POST /admin/init` handler. Requires
 * `Authorization: Bearer $CONFORMANCE_ADMIN_TOKEN`; anything else is 401.
 */
export function createAdminInit(
  env: ConformanceEnv,
): (request: Request) => Promise<Response> {
  return async (request) => {
    // Refuse outright when the secret is unset — otherwise a literal
    // "Bearer undefined" header would authenticate.
    const auth = request.headers.get("authorization");
    if (
      !env.CONFORMANCE_ADMIN_TOKEN ||
      auth !== `Bearer ${env.CONFORMANCE_ADMIN_TOKEN}`
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (request.method.toUpperCase() !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    const results: Record<string, string> = {};

    await createIndieAuthStore(env).init();
    results["@dwk/indieauth"] = "initialized";

    await createMicropubStore(env).init();
    results["@dwk/micropub"] = "initialized";

    await createMicrosubStore(env).init();
    results["@dwk/microsub"] = "initialized";

    for (const [name, reason] of Object.entries(UNAVAILABLE_PACKAGES)) {
      results[name] = `unavailable: ${reason}`;
    }

    return new Response(JSON.stringify({ initialized: results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
