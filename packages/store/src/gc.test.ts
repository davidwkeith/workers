import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { collectGarbage, d1OrphanSink, ensureGcSchema } from "./index";
import type { HarnessEnv } from "./test-harness";

const harness = env as unknown as HarnessEnv;

beforeEach(async () => {
  await ensureGcSchema(harness.GC_DB);
});

describe("@dwk/store GC requires no Durable Object sweep", () => {
  it("reclaims orphans using only the D1 tracking store and R2", async () => {
    // Seed an orphan straight into the shared tracking store + R2, with no
    // Durable Object in the picture at all.
    const blobKey = `pod-xyz/blobs/sha256-${crypto.randomUUID()}`;
    await harness.BLOBS.put(blobKey, new TextEncoder().encode("garbage"));
    const enqueuedAt = Date.now() - 10_000;
    await d1OrphanSink(harness.GC_DB).enqueue([{ blobKey, enqueuedAt }]);

    // Still inside the window → untouched.
    expect(
      await collectGarbage(harness, { safetyWindowMs: 60_000 }),
    ).toHaveLength(0);
    expect(await harness.BLOBS.get(blobKey)).not.toBeNull();

    // Window elapsed → reclaimed, working purely off D1 + R2.
    const reclaimed = await collectGarbage(harness, { safetyWindowMs: 1_000 });
    expect(reclaimed).toContain(blobKey);
    expect(await harness.BLOBS.get(blobKey)).toBeNull();
  });

  it("does not reclaim more than the requested limit", async () => {
    const enqueuedAt = Date.now() - 10_000;
    const keys = Array.from(
      { length: 3 },
      () => `pod-lim/blobs/sha256-${crypto.randomUUID()}`,
    );
    for (const k of keys) {
      await harness.BLOBS.put(k, new TextEncoder().encode("x"));
    }
    await d1OrphanSink(harness.GC_DB).enqueue(
      keys.map((blobKey) => ({ blobKey, enqueuedAt })),
    );

    const first = await collectGarbage(harness, {
      safetyWindowMs: 1_000,
      limit: 2,
    });
    expect(first).toHaveLength(2);
    const second = await collectGarbage(harness, { safetyWindowMs: 1_000 });
    expect(second.length).toBeGreaterThanOrEqual(1);
  });
});
