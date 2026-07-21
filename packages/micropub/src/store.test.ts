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

  it("listPosts works without a prior init()", async () => {
    const store = createMicropubStore(harness);
    const posts = await store.listPosts({ limit: 10, offset: 0 });
    expect(posts).toEqual([]);
  });
});

describe("listPosts", () => {
  it("returns empty array for empty store", async () => {
    const store = createMicropubStore(harness);
    await store.init();
    const posts = await store.listPosts({ limit: 10, offset: 0 });
    expect(posts).toEqual([]);
  });

  it("returns posts in DESC order by created_at", async () => {
    const store = createMicropubStore(harness);
    await store.init();
    await store.insertPost({
      url: "https://example.com/old",
      type: "h-entry",
      properties: { content: ["old"] },
      now: 1,
    });
    await store.insertPost({
      url: "https://example.com/new",
      type: "h-entry",
      properties: { content: ["new"] },
      now: 2,
    });
    const posts = await store.listPosts({ limit: 10, offset: 0 });
    expect(posts).toHaveLength(2);
    expect(posts[0]!.url).toBe("https://example.com/new");
    expect(posts[1]!.url).toBe("https://example.com/old");
  });

  it("respects limit", async () => {
    const store = createMicropubStore(harness);
    await store.init();
    for (let i = 0; i < 5; i++) {
      await store.insertPost({
        url: `https://example.com/post-${i}`,
        type: "h-entry",
        properties: { content: [`post ${i}`] },
        now: i,
      });
    }
    const posts = await store.listPosts({ limit: 2, offset: 0 });
    expect(posts).toHaveLength(2);
  });

  it("respects offset", async () => {
    const store = createMicropubStore(harness);
    await store.init();
    for (let i = 0; i < 5; i++) {
      await store.insertPost({
        url: `https://example.com/post-${i}`,
        type: "h-entry",
        properties: { content: [`post ${i}`] },
        now: i,
      });
    }
    const first = await store.listPosts({ limit: 10, offset: 0 });
    const second = await store.listPosts({ limit: 10, offset: 2 });
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(3);
    expect(second[0]!.url).toBe(first[2]!.url);
  });

  it("excludes soft-deleted posts", async () => {
    const store = createMicropubStore(harness);
    await store.init();
    await store.insertPost({
      url: "https://example.com/live",
      type: "h-entry",
      properties: { content: ["live"] },
      now: 1,
    });
    await store.insertPost({
      url: "https://example.com/deleted",
      type: "h-entry",
      properties: { content: ["deleted"] },
      now: 2,
    });
    await store.setDeleted("https://example.com/deleted", true, 3);
    const posts = await store.listPosts({ limit: 10, offset: 0 });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://example.com/live");
  });

  it("has deterministic ordering with same created_at (url DESC tiebreaker)", async () => {
    const store = createMicropubStore(harness);
    await store.init();
    const now = Math.floor(Date.now() / 1000);
    await store.insertPost({
      url: "https://example.com/a",
      type: "h-entry",
      properties: { content: ["a"] },
      now,
    });
    await store.insertPost({
      url: "https://example.com/b",
      type: "h-entry",
      properties: { content: ["b"] },
      now,
    });
    const posts1 = await store.listPosts({ limit: 10, offset: 0 });
    const posts2 = await store.listPosts({ limit: 10, offset: 0 });
    expect(posts1[0]!.url).toBe(posts2[0]!.url);
    expect(posts1[1]!.url).toBe(posts2[1]!.url);
  });
});
