import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { d1OrphanSink, ensureGcSchema } from "@dwk/store";

import { createSolidPodGc } from "./index";
import type { SolidPodGcEnv } from "./config";

/**
 * Unit tests for the cron GC wiring (`createSolidPodGc`). The reclamation
 * semantics themselves live in (and are tested by) `@dwk/store`; here we only
 * assert the thin endpoint behaviour: fail-loud on missing bindings, and that
 * the handler creates the shared schema and drives `collectGarbage` end to end.
 */

const gcEnv = env as unknown as SolidPodGcEnv;

const BASE = "https://gc.pod.example";

function gcConfig(extra: Record<string, unknown> = {}) {
  return {
    baseUrl: BASE,
    issuer: "https://issuer.example",
    audience: "solid",
    jwks: [],
    owner: "https://owner.example/profile#me",
    ...extra,
  };
}

const event = {} as ScheduledController;
const ctx = {} as ExecutionContext;

describe("@dwk/solid-pod GC fail-loud on missing bindings", () => {
  it("throws when the BLOBS R2 binding is absent", async () => {
    const handler = createSolidPodGc(gcConfig());
    const broken = { GC_DB: gcEnv.GC_DB } as unknown as SolidPodGcEnv;
    await expect(handler(event, broken, ctx)).rejects.toThrow(/BLOBS/);
  });

  it("throws when the GC_DB D1 binding is absent", async () => {
    const handler = createSolidPodGc(gcConfig());
    const broken = { BLOBS: gcEnv.BLOBS } as unknown as SolidPodGcEnv;
    await expect(handler(event, broken, ctx)).rejects.toThrow(/GC_DB/);
  });
});

describe("@dwk/solid-pod GC cron handler", () => {
  it("creates the shared orphan schema and runs without throwing", async () => {
    const handler = createSolidPodGc(gcConfig());
    await expect(handler(event, gcEnv, ctx)).resolves.toBeUndefined();

    // The shared tracking table now exists and is queryable.
    const { results } = await gcEnv.GC_DB.prepare(
      "SELECT COUNT(*) AS n FROM orphan_blobs",
    ).all<{ n: number }>();
    expect(results.length).toBe(1);
  });

  it("reclaims an orphan whose tracking row is past the safety window", async () => {
    // A zero-length safety window makes any already-enqueued orphan eligible on
    // the next run, so the cron handler reclaims it from R2.
    const handler = createSolidPodGc(gcConfig({ gcSafetyWindowMs: 0 }));
    await ensureGcSchema(gcEnv.GC_DB);

    const blobKey = `gc-cron/blobs/sha256-${crypto.randomUUID()}`;
    await gcEnv.BLOBS.put(blobKey, new TextEncoder().encode("garbage"));
    // Enqueue with `enqueuedAt` at (≈) upload time so the resurrection
    // heuristic (uploaded > enqueuedAt + skew) does not treat it as live.
    await d1OrphanSink(gcEnv.GC_DB).enqueue([
      { blobKey, enqueuedAt: Date.now() },
    ]);

    await handler(event, gcEnv, ctx);

    expect(await gcEnv.BLOBS.get(blobKey)).toBeNull();
  });
});
