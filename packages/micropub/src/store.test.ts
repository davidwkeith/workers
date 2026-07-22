import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createDpopReplayStore } from "./replay.js";
import { parseSourceListFilters } from "./source-filters.js";
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
    expect(Array.isArray(posts)).toBe(true);
  });
});

describe("listPosts", () => {
  it("returns posts in DESC order by created_at", async () => {
    const store = createMicropubStore(harness);
    await store.init();
    await store.insertPost({
      url: "https://example.com/desc-order-old",
      type: "h-entry",
      properties: { content: ["old"] },
      now: 1,
    });
    await store.insertPost({
      url: "https://example.com/desc-order-new",
      type: "h-entry",
      properties: { content: ["new"] },
      now: 2,
    });
    const posts = await store.listPosts({ limit: 10, offset: 0 });
    const matching = posts.filter((p) => p.url.includes("desc-order"));
    expect(matching.length).toBeGreaterThanOrEqual(2);
    expect(matching[0]!.url).toBe("https://example.com/desc-order-new");
  });

  it("respects limit", async () => {
    const store = createMicropubStore(harness);
    await store.init();
    for (let i = 0; i < 5; i++) {
      await store.insertPost({
        url: `https://example.com/limit-test-${i}`,
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
        url: `https://example.com/offset-test-${i}`,
        type: "h-entry",
        properties: { content: [`post ${i}`] },
        now: i,
      });
    }
    const first = await store.listPosts({ limit: 10, offset: 0 });
    const second = await store.listPosts({ limit: 10, offset: 2 });
    expect(first.length).toBeGreaterThanOrEqual(5);
    expect(second.length).toBeGreaterThanOrEqual(3);
  });

  it("excludes soft-deleted posts", async () => {
    const store = createMicropubStore(harness);
    await store.init();
    await store.insertPost({
      url: "https://example.com/soft-delete-live",
      type: "h-entry",
      properties: { content: ["live"] },
      now: 1,
    });
    await store.insertPost({
      url: "https://example.com/soft-delete-deleted",
      type: "h-entry",
      properties: { content: ["deleted"] },
      now: 2,
    });
    await store.setDeleted("https://example.com/soft-delete-deleted", true, 3);
    const posts = await store.listPosts({ limit: 10, offset: 0 });
    const matching = posts.filter((p) => p.url.includes("soft-delete"));
    expect(matching).toHaveLength(1);
    expect(matching[0]!.url).toBe("https://example.com/soft-delete-live");
  });

  it("has deterministic ordering with same created_at (url DESC tiebreaker)", async () => {
    const store = createMicropubStore(harness);
    await store.init();
    const now = Math.floor(Date.now() / 1000);
    await store.insertPost({
      url: "https://example.com/tiebreak-a",
      type: "h-entry",
      properties: { content: ["a"] },
      now,
    });
    await store.insertPost({
      url: "https://example.com/tiebreak-b",
      type: "h-entry",
      properties: { content: ["b"] },
      now,
    });
    const posts1 = await store.listPosts({ limit: 10, offset: 0 });
    const posts2 = await store.listPosts({ limit: 10, offset: 0 });
    const urls1 = posts1.map((p) => p.url);
    const urls2 = posts2.map((p) => p.url);
    expect(urls1).toEqual(urls2);
  });

  it("composes proposed filters and continues from an exclusive keyset", async () => {
    const store = createMicropubStore(harness);
    await store.init();
    await store.insertPost({
      url: "https://example.com/filter-a",
      type: "h-entry",
      properties: {
        content: ["a"],
        category: ["workers"],
        "post-status": ["draft"],
      },
      now: 10,
    });
    await store.insertPost({
      url: "https://example.com/filter-b",
      type: "h-entry",
      properties: {
        content: ["b"],
        category: ["workers"],
        "post-status": ["draft"],
      },
      now: 11,
    });
    const filters = parseSourceListFilters(
      new URLSearchParams(
        "post-type=h-entry&post-status=draft&property-exists%5B%5D=content&property-value%5Bcategory%5D=workers",
      ),
    );
    const first = await store.listPosts(
      { limit: 1, offset: 0 },
      { filters, lookahead: true },
    );
    expect(first.map((post) => post.url)).toEqual([
      "https://example.com/filter-b",
      "https://example.com/filter-a",
    ]);
    const second = await store.listPosts(
      { limit: 1, offset: 0 },
      {
        filters,
        cursor: { createdAt: first[0]!.createdAt, url: first[0]!.url },
      },
    );
    expect(second.map((post) => post.url)).toEqual([
      "https://example.com/filter-a",
    ]);
  });
});
