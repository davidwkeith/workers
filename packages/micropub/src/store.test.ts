import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createDpopReplayStore } from "./replay.js";
import { createMicropubStore, type MicropubStoreEnv } from "./store.js";

/**
 * Fresh-deploy regression: the post store and the DPoP replay store must
 * materialise their own schema lazily, so a consumer that composes
 * `@dwk/micropub` against a brand-new D1 does not 500 on the first publish or
 * the first authenticated (replay-checked) request. Each test file gets
 * isolated D1 storage, so these run against an empty database with no `init()`.
 */

const harness = env as unknown as MicropubStoreEnv;

describe("lazy schema on a fresh D1 (no init)", () => {
  it("insertPost/getPost work without a prior init()", async () => {
    const store = createMicropubStore(harness);
    const inserted = await store.insertPost({
      url: "https://example.com/a",
      type: "h-entry",
      properties: { content: ["hi"] },
      now: 1,
    });
    expect(inserted).toBe(true);
    expect((await store.getPost("https://example.com/a"))?.type).toBe(
      "h-entry",
    );
  });

  it("recordProof works (and detects replay) without a prior init()", async () => {
    const store = createDpopReplayStore(harness);
    expect(await store.recordProof("jti-1", 100, 1)).toBe(true);
    expect(await store.recordProof("jti-1", 100, 1)).toBe(false);
  });
});
