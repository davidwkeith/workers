import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createMicrosubStore,
  NOTIFICATIONS_CHANNEL,
  type MicrosubStore,
  type MicrosubStoreEnv,
} from "./store";
import type { Jf2Entry } from "./jf2";

const harness = env as unknown as MicrosubStoreEnv;
let store: MicrosubStore;

function entry(id: string, published?: string): Jf2Entry {
  return {
    type: "entry",
    _id: id,
    name: `Title ${id}`,
    content: { text: `Body ${id}` },
    ...(published ? { published } : {}),
  };
}

beforeEach(async () => {
  store = createMicrosubStore(harness);
  await store.init();
});

describe("channels", () => {
  it("always exposes a reserved notifications channel first", async () => {
    const channels = await store.listChannels();
    expect(channels[0]?.uid).toBe(NOTIFICATIONS_CHANNEL);
  });

  it("creates, renames, reorders, and deletes channels", async () => {
    const a = await store.createChannel("Photos", 100);
    const b = await store.createChannel("News", 101);
    expect(await store.channelExists(a.uid)).toBe(true);

    const renamed = await store.renameChannel(a.uid, "Pictures");
    expect(renamed?.name).toBe("Pictures");

    await store.reorderChannels([b.uid, a.uid]);
    const ordered = await store.listChannels();
    const positions = ordered
      .filter((c) => c.uid !== NOTIFICATIONS_CHANNEL)
      .map((c) => c.uid);
    expect(positions).toEqual([b.uid, a.uid]);

    expect(await store.deleteChannel(a.uid)).toBe(true);
    expect(await store.channelExists(a.uid)).toBe(false);
  });

  it("protects the reserved channel from rename and delete", async () => {
    expect(await store.renameChannel(NOTIFICATIONS_CHANNEL, "Nope")).toBeNull();
    expect(await store.deleteChannel(NOTIFICATIONS_CHANNEL)).toBe(false);
  });

  it("reports unknown channels on rename/delete", async () => {
    expect(await store.renameChannel("ghost", "x")).toBeNull();
    expect(await store.deleteChannel("ghost")).toBe(false);
  });
});

describe("follows", () => {
  it("adds, lists, and removes by feed or page URL", async () => {
    const channel = await store.createChannel("Blogs", 1);
    await store.addFollow(
      channel.uid,
      "https://feed.example/atom",
      "https://feed.example/",
      1,
    );
    expect(await store.listFollows(channel.uid)).toHaveLength(1);
    expect(await store.distinctFeedUrls()).toContain(
      "https://feed.example/atom",
    );
    expect(await store.channelsForFeed("https://feed.example/atom")).toEqual([
      channel.uid,
    ]);

    // Unfollow with the page URL the client was given back.
    expect(await store.removeFollow(channel.uid, "https://feed.example/")).toBe(
      true,
    );
    expect(await store.listFollows(channel.uid)).toHaveLength(0);
  });
});

describe("items", () => {
  it("dedupes across inserts and tracks read state + unread counts", async () => {
    const channel = await store.createChannel("C", 1);
    const feed = "https://f.example/atom";
    const first = await store.insertItems(
      channel.uid,
      feed,
      [entry("1"), entry("2")],
      10,
      5000,
    );
    expect(first).toBe(2);
    // Re-inserting the same ids adds nothing.
    const second = await store.insertItems(
      channel.uid,
      feed,
      [entry("2"), entry("3")],
      11,
      5000,
    );
    expect(second).toBe(1);

    expect(await store.unreadCount(channel.uid)).toBe(3);
    await store.markRead(channel.uid, ["1"], true);
    expect(await store.unreadCount(channel.uid)).toBe(2);
    await store.markRead(channel.uid, ["1"], false);
    expect(await store.unreadCount(channel.uid)).toBe(3);
  });

  it("paginates with before/after cursors", async () => {
    const channel = await store.createChannel("C", 1);
    const feed = "https://f.example/atom";
    await store.insertItems(
      channel.uid,
      feed,
      [entry("1"), entry("2"), entry("3"), entry("4"), entry("5")],
      10,
      5000,
    );

    const page1 = await store.listItems(channel.uid, { limit: 2 });
    expect(page1.items.map((i) => i.entryId)).toEqual(["5", "4"]);
    expect(page1.before).toBeDefined();

    const page2 = await store.listItems(channel.uid, {
      before: page1.before!,
      limit: 2,
    });
    expect(page2.items.map((i) => i.entryId)).toEqual(["3", "2"]);

    const newer = await store.listItems(channel.uid, {
      after: page2.after!,
      limit: 10,
    });
    expect(newer.items.map((i) => i.entryId)).toEqual(["5", "4"]);
  });

  it("marks read through a cursor and removes items", async () => {
    const channel = await store.createChannel("C", 1);
    const feed = "https://f.example/atom";
    await store.insertItems(
      channel.uid,
      feed,
      [entry("1"), entry("2"), entry("3")],
      10,
      5000,
    );

    // Items inserted oldest-first: 1,2,3 ascending seq. mark_read through "2".
    await store.markReadThrough(channel.uid, "2");
    expect(await store.unreadCount(channel.uid)).toBe(1);
    // Unknown id is a no-op.
    await store.markReadThrough(channel.uid, "ghost");
    expect(await store.unreadCount(channel.uid)).toBe(1);

    expect(await store.removeItem(channel.uid, "3")).toBe(true);
    expect(await store.removeItem(channel.uid, "3")).toBe(false);
  });

  it("reaps items past the retention ceiling, keeping the newest", async () => {
    const channel = await store.createChannel("C", 1);
    const feed = "https://f.example/atom";
    await store.insertItems(
      channel.uid,
      feed,
      [entry("1"), entry("2"), entry("3")],
      10,
      2, // keep only 2
    );
    const page = await store.listItems(channel.uid, { limit: 10 });
    expect(page.items.map((i) => i.entryId)).toEqual(["3", "2"]);
  });

  it("searches item name + content", async () => {
    const channel = await store.createChannel("C", 1);
    const feed = "https://f.example/atom";
    await store.insertItems(
      channel.uid,
      feed,
      [entry("1"), entry("2")],
      10,
      5000,
    );
    const results = await store.searchItems(channel.uid, "Body 2", 10);
    expect(results.map((r) => r.entryId)).toEqual(["2"]);
  });
});

describe("feed poll cache", () => {
  it("round-trips validators", async () => {
    const feed = "https://f.example/atom";
    expect(await store.getFeedCache(feed)).toBeNull();
    await store.setFeedCache(feed, '"etag"', "Mon", 99);
    expect(await store.getFeedCache(feed)).toEqual({
      etag: '"etag"',
      lastModified: "Mon",
    });
    await store.setFeedCache(feed, '"etag2"', null, 100);
    expect(await store.getFeedCache(feed)).toEqual({
      etag: '"etag2"',
      lastModified: null,
    });
  });
});
