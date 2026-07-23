import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  MediaValidationError,
  createMicropubMediaStore,
  mediaKeyFromUrl,
  mediaTrashKey,
  parseMediaSourceParams,
} from "./media.js";
import type { MediaStoreEnv } from "./media.js";

const harness = env as unknown as MediaStoreEnv;

const MEDIA = "https://example.com/media";
const KEY = "6d9f2c3a-1b4e-4f5a-8c7d-0e1f2a3b4c5d.jpg";
const BARE_KEY = "6d9f2c3a-1b4e-4f5a-8c7d-0e1f2a3b4c5d";

// --- URL ownership validation ------------------------------------------------

describe("mediaKeyFromUrl", () => {
  it("accepts a canonical media URL with a known extension", () => {
    expect(mediaKeyFromUrl(`${MEDIA}/${KEY}`, MEDIA)).toBe(KEY);
  });

  it("accepts a canonical media URL with no extension", () => {
    expect(mediaKeyFromUrl(`${MEDIA}/${BARE_KEY}`, MEDIA)).toBe(BARE_KEY);
  });

  it("canonicalizes a default port to the same origin", () => {
    expect(mediaKeyFromUrl(`https://example.com:443/media/${KEY}`, MEDIA)).toBe(
      KEY,
    );
  });

  it.each([
    ["a foreign origin", `https://evil.example.net/media/${KEY}`],
    ["a different path prefix", `https://example.com/other/${KEY}`],
    ["the media endpoint itself", MEDIA],
    ["a trailing extra segment", `${MEDIA}/${KEY}/extra`],
    ["a traversal segment", `${MEDIA}/../secret/${KEY}`],
    ["an encoded slash in the key", `${MEDIA}/${BARE_KEY}%2Fescape`],
    ["an encoded traversal", `${MEDIA}/%2E%2E/${KEY}`],
    ["the trash prefix", `${MEDIA}/.trash/${KEY}`],
    ["a query string", `${MEDIA}/${KEY}?x=1`],
    ["a fragment", `${MEDIA}/${KEY}#frag`],
    ["an uppercase UUID", `${MEDIA}/${BARE_KEY.toUpperCase()}`],
    ["an unknown extension", `${MEDIA}/${BARE_KEY}.html`],
    ["a non-UUID key", `${MEDIA}/notauuid.jpg`],
    ["a relative URL", `/media/${KEY}`],
    ["a non-http scheme", `ftp://example.com/media/${KEY}`],
  ])("rejects %s", (_label, url) => {
    expect(mediaKeyFromUrl(url, MEDIA)).toBeNull();
  });
});

describe("mediaTrashKey", () => {
  it("prefixes the key with the trash namespace", () => {
    expect(mediaTrashKey(KEY)).toBe(`.trash/${KEY}`);
  });
});

// --- `q=source` (media) parameter parsing -------------------------------------

function params(query: string): URLSearchParams {
  return new URL(`${MEDIA}?${query}`).searchParams;
}

describe("parseMediaSourceParams", () => {
  it("defaults to the first page of ten", () => {
    expect(parseMediaSourceParams(params("q=source"))).toEqual({
      page: { limit: 10, offset: 0 },
    });
  });

  it("parses explicit limit and offset", () => {
    expect(
      parseMediaSourceParams(params("q=source&limit=5&offset=20")),
    ).toEqual({ page: { limit: 5, offset: 20 } });
  });

  it("caps limit at 100", () => {
    expect(parseMediaSourceParams(params("q=source&limit=500"))).toEqual({
      page: { limit: 100, offset: 0 },
    });
  });

  it("returns the url form when `url` is present", () => {
    expect(
      parseMediaSourceParams(params(`q=source&url=${MEDIA}/${KEY}`)),
    ).toEqual({ url: `${MEDIA}/${KEY}` });
  });

  it.each([
    ["an unknown parameter", "q=source&nope=1"],
    ["a repeated url", `q=source&url=${MEDIA}/a&url=${MEDIA}/b`],
    ["a repeated limit", "q=source&limit=1&limit=2"],
    ["url combined with limit", `q=source&url=${MEDIA}/${KEY}&limit=5`],
    ["url combined with offset", `q=source&url=${MEDIA}/${KEY}&offset=5`],
    ["a non-numeric limit", "q=source&limit=abc"],
    ["a zero limit", "q=source&limit=0"],
    ["a negative offset", "q=source&offset=-1"],
    ["a fractional limit", "q=source&limit=1.5"],
  ])("rejects %s", (_label, query) => {
    expect(() => parseMediaSourceParams(params(query))).toThrow(
      MediaValidationError,
    );
  });
});

// --- D1 media metadata store --------------------------------------------------

describe("createMicropubMediaStore", () => {
  const store = createMicropubMediaStore(harness);

  beforeEach(async () => {
    await store.init();
    await harness.MICROPUB_DB.prepare("DELETE FROM micropub_media").run();
  });

  it("records an upload and reads it back", async () => {
    await store.record({
      key: KEY,
      contentType: "image/jpeg",
      sizeBytes: 123,
      now: 1000,
    });
    expect(await store.get(KEY)).toEqual({
      key: KEY,
      contentType: "image/jpeg",
      sizeBytes: 123,
      uploadedAt: 1000,
      deletedAt: null,
    });
  });

  it("returns null for an unknown key", async () => {
    expect(await store.get("missing")).toBeNull();
  });

  it("lists live media newest-first with key as the tie-breaker", async () => {
    await store.record({ key: "b", contentType: "t", sizeBytes: 1, now: 100 });
    await store.record({ key: "a", contentType: "t", sizeBytes: 1, now: 100 });
    await store.record({ key: "c", contentType: "t", sizeBytes: 1, now: 200 });
    const keys = (await store.list({ limit: 10, offset: 0 })).map((r) => r.key);
    expect(keys).toEqual(["c", "b", "a"]);
  });

  it("paginates with limit and offset", async () => {
    for (const [key, now] of [
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ] as const) {
      await store.record({ key, contentType: "t", sizeBytes: 1, now });
    }
    const page = await store.list({ limit: 1, offset: 1 });
    expect(page.map((r) => r.key)).toEqual(["b"]);
  });

  it("excludes soft-deleted media from listings", async () => {
    await store.record({ key: "a", contentType: "t", sizeBytes: 1, now: 1 });
    await store.record({ key: "b", contentType: "t", sizeBytes: 1, now: 2 });
    expect(await store.setDeleted("b", 3)).toBe(true);
    const keys = (await store.list({ limit: 10, offset: 0 })).map((r) => r.key);
    expect(keys).toEqual(["a"]);
    expect((await store.get("b"))?.deletedAt).toBe(3);
  });

  it("clears the soft-delete flag on undelete", async () => {
    await store.record({ key: "a", contentType: "t", sizeBytes: 1, now: 1 });
    await store.setDeleted("a", 2);
    expect(await store.setDeleted("a", null)).toBe(true);
    expect((await store.get("a"))?.deletedAt).toBeNull();
  });

  it("reports an unknown key on setDeleted", async () => {
    expect(await store.setDeleted("missing", 1)).toBe(false);
  });

  it("prunes only rows deleted before the cutoff", async () => {
    await store.record({ key: "old", contentType: "t", sizeBytes: 1, now: 1 });
    await store.record({
      key: "recent",
      contentType: "t",
      sizeBytes: 1,
      now: 2,
    });
    await store.record({ key: "live", contentType: "t", sizeBytes: 1, now: 3 });
    await store.setDeleted("old", 10);
    await store.setDeleted("recent", 100);
    await store.pruneExpired(50);
    expect(await store.get("old")).toBeNull();
    expect((await store.get("recent"))?.deletedAt).toBe(100);
    expect((await store.get("live"))?.deletedAt).toBeNull();
  });
});
