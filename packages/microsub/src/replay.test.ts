import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createDpopReplayStore } from "./replay.js";
import type { MicrosubStoreEnv } from "./store.js";

/**
 * Fresh-deploy regression: the DPoP replay store must materialise its own schema
 * lazily, so a consumer that composes `@dwk/microsub` against a brand-new D1
 * does not 500 on the first authenticated (replay-checked) request. Each test
 * file gets isolated D1 storage, so this runs against an empty database with no
 * `init()` call.
 */

const harness = env as unknown as MicrosubStoreEnv;

describe("lazy schema on a fresh D1 (no init)", () => {
  it("recordProof works (and detects replay) without a prior init()", async () => {
    const store = createDpopReplayStore(harness);
    expect(await store.recordProof("jti-1", 100, 1)).toBe(true);
    expect(await store.recordProof("jti-1", 100, 1)).toBe(false);
  });
});
