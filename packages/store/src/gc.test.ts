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
    // Durable Object in the picture at all. The object is uploaded first, then
    // orphaned — the realistic ordering.
    const blobKey = `pod-xyz/blobs/sha256-${crypto.randomUUID()}`;
    await harness.BLOBS.put(blobKey, new TextEncoder().encode("garbage"));
    const enqueuedAt = Date.now();
    await d1OrphanSink(harness.GC_DB).enqueue([{ blobKey, enqueuedAt }]);

    // Still inside the window → untouched.
    expect(
      await collectGarbage(harness, { safetyWindowMs: 60_000 }),
    ).toHaveLength(0);
    expect(await harness.BLOBS.get(blobKey)).not.toBeNull();

    // Window elapsed → reclaimed, working purely off D1 + R2.
    const reclaimed = await collectGarbage(harness, {
      now: Date.now() + 120_000,
      safetyWindowMs: 60_000,
    });
    expect(reclaimed).toContain(blobKey);
    expect(await harness.BLOBS.get(blobKey)).toBeNull();
  });

  it("keeps a resurrected key whose object was re-uploaded after orphaning", async () => {
    const blobKey = `pod-res/blobs/sha256-${crypto.randomUUID()}`;
    // Orphaned in the past ...
    const enqueuedAt = Date.now() - 60_000;
    await d1OrphanSink(harness.GC_DB).enqueue([{ blobKey, enqueuedAt }]);
    // ... but the identical content was re-uploaded since (now > enqueuedAt).
    await harness.BLOBS.put(blobKey, new TextEncoder().encode("resurrected"));

    const reclaimed = await collectGarbage(harness, { safetyWindowMs: 1_000 });
    // The live object must survive even though its tracking row was eligible.
    expect(reclaimed).not.toContain(blobKey);
    expect(await harness.BLOBS.get(blobKey)).not.toBeNull();
    // The stale tracking row is cleared, so it is not revisited.
    expect(await collectGarbage(harness, { safetyWindowMs: 1_000 })).toEqual(
      [],
    );
  });

  it("dedups orphan inserts on blob_key, keeping the max enqueued_at", async () => {
    const blobKey = `pod-dedup/blobs/sha256-${crypto.randomUUID()}`;
    const sink = d1OrphanSink(harness.GC_DB);
    const earlier = Date.now() - 30_000;
    const later = Date.now();
    // Forward the same key twice (at-least-once forwarding / re-orphaning),
    // out of order, to prove the latest orphaning wins.
    await sink.enqueue([{ blobKey, enqueuedAt: later }]);
    await sink.enqueue([{ blobKey, enqueuedAt: earlier }]);

    const { results } = await harness.GC_DB.prepare(
      "SELECT blob_key, enqueued_at FROM orphan_blobs WHERE blob_key = ?",
    )
      .bind(blobKey)
      .all<{ blob_key: string; enqueued_at: number }>();
    expect(results).toHaveLength(1);
    expect(results[0]!.enqueued_at).toBe(later);
  });

  it("treats an object uploaded within the clock-skew margin as a genuine orphan", async () => {
    const blobKey = `pod-skew/blobs/sha256-${crypto.randomUUID()}`;
    await harness.BLOBS.put(blobKey, new TextEncoder().encode("x"));
    // Orphaned ~2s before the (just-now) upload: inside the default 5s skew
    // margin, so the timestamp guard must not mistake it for a resurrection.
    const enqueuedAt = Date.now() - 2_000;
    await d1OrphanSink(harness.GC_DB).enqueue([{ blobKey, enqueuedAt }]);

    const reclaimed = await collectGarbage(harness, {
      now: Date.now() + 120_000,
      safetyWindowMs: 60_000,
    });
    expect(reclaimed).toContain(blobKey);
    expect(await harness.BLOBS.get(blobKey)).toBeNull();
  });

  it("honours a configurable clock-skew margin", async () => {
    const blobKey = `pod-skew2/blobs/sha256-${crypto.randomUUID()}`;
    await harness.BLOBS.put(blobKey, new TextEncoder().encode("x"));
    const enqueuedAt = Date.now() - 2_000;
    await d1OrphanSink(harness.GC_DB).enqueue([{ blobKey, enqueuedAt }]);

    // With a 1s margin the just-uploaded object reads as resurrected → kept.
    const reclaimed = await collectGarbage(harness, {
      now: Date.now() + 120_000,
      safetyWindowMs: 60_000,
      clockSkewMs: 1_000,
    });
    expect(reclaimed).not.toContain(blobKey);
    expect(await harness.BLOBS.get(blobKey)).not.toBeNull();
  });

  it("does not reclaim more than the requested limit", async () => {
    const keys = Array.from(
      { length: 3 },
      () => `pod-lim/blobs/sha256-${crypto.randomUUID()}`,
    );
    for (const k of keys) {
      await harness.BLOBS.put(k, new TextEncoder().encode("x"));
    }
    // Orphan only after the objects exist, so the resurrection guard treats
    // them as genuinely stale.
    const enqueuedAt = Date.now();
    await d1OrphanSink(harness.GC_DB).enqueue(
      keys.map((blobKey) => ({ blobKey, enqueuedAt })),
    );

    const now = Date.now() + 120_000;
    const first = await collectGarbage(harness, {
      now,
      safetyWindowMs: 60_000,
      limit: 2,
    });
    expect(first).toHaveLength(2);
    const second = await collectGarbage(harness, {
      now,
      safetyWindowMs: 60_000,
    });
    expect(second.length).toBeGreaterThanOrEqual(1);
  });
});
