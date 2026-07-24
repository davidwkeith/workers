import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createD1Inbox } from "./inbox.js";

interface TestEnv {
  WEBMENTION_INBOX: import("@cloudflare/workers-types").D1Database;
}

const db = (env as unknown as TestEnv).WEBMENTION_INBOX;

describe("createD1Inbox", () => {
  it("creates its table on first use and stores then lists a mention", async () => {
    const inbox = createD1Inbox(db, { table: "wm_store" });
    await inbox.store({
      source: "https://a.example/p",
      target: "https://example.com/x",
      verifiedAt: 1000,
    });
    const all = await inbox.list();
    expect(all).toEqual([
      {
        id: expect.stringMatching(/^wm-/),
        source: "https://a.example/p",
        target: "https://example.com/x",
        verifiedAt: 1000,
      },
    ]);
  });

  it("upserts on the (source, target) key", async () => {
    const inbox = createD1Inbox(db, { table: "wm_upsert" });
    const mention = {
      source: "https://a.example/p",
      target: "https://example.com/x",
    };
    await inbox.store({ ...mention, verifiedAt: 1 });
    await inbox.store({ ...mention, verifiedAt: 2 });
    const all = await inbox.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.verifiedAt).toBe(2);
  });

  it("lists newest first and filters by target", async () => {
    const inbox = createD1Inbox(db, { table: "wm_filter" });
    await inbox.store({
      source: "https://a.example/1",
      target: "https://example.com/x",
      verifiedAt: 10,
    });
    await inbox.store({
      source: "https://a.example/2",
      target: "https://example.com/x",
      verifiedAt: 20,
    });
    await inbox.store({
      source: "https://a.example/3",
      target: "https://example.com/y",
      verifiedAt: 30,
    });

    const forX = await inbox.list("https://example.com/x");
    expect(forX.map((m) => m.source)).toEqual([
      "https://a.example/2",
      "https://a.example/1",
    ]);
  });

  it("removes a mention", async () => {
    const inbox = createD1Inbox(db, { table: "wm_remove" });
    const mention = {
      source: "https://a.example/p",
      target: "https://example.com/x",
      verifiedAt: 1,
    };
    await inbox.store(mention);
    await inbox.remove(mention.source, mention.target);
    expect(await inbox.list()).toEqual([]);
    // Removing an absent mention is a no-op.
    await inbox.remove(mention.source, mention.target);
  });

  it("persists and lists an rsvp value", async () => {
    const inbox = createD1Inbox(db, { table: "wm_rsvp" });
    await inbox.store({
      source: "https://a.example/rsvp",
      target: "https://example.com/party",
      verifiedAt: 5,
      rsvp: "yes",
    });
    expect(await inbox.list()).toEqual([
      {
        id: expect.stringMatching(/^wm-/),
        source: "https://a.example/rsvp",
        target: "https://example.com/party",
        verifiedAt: 5,
        rsvp: "yes",
      },
    ]);
  });

  it("clears the rsvp when a mention is re-stored without one", async () => {
    const inbox = createD1Inbox(db, { table: "wm_rsvp_clear" });
    const mention = {
      source: "https://a.example/p",
      target: "https://example.com/party",
    };
    await inbox.store({ ...mention, verifiedAt: 1, rsvp: "maybe" });
    await inbox.store({ ...mention, verifiedAt: 2 });
    const all = await inbox.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.rsvp).toBeUndefined();
  });

  it("persists and lists interactionType, author, content, and publishedAt", async () => {
    const inbox = createD1Inbox(db, { table: "wm_enriched" });
    await inbox.store({
      source: "https://a.example/reply",
      target: "https://example.com/post",
      verifiedAt: 100,
      interactionType: "reply",
      author: { name: "Jane", url: "https://jane.example/" },
      content: "Nice post!",
      publishedAt: 50,
    });
    expect(await inbox.list()).toEqual([
      {
        id: expect.stringMatching(/^wm-/),
        source: "https://a.example/reply",
        target: "https://example.com/post",
        verifiedAt: 100,
        interactionType: "reply",
        author: { name: "Jane", url: "https://jane.example/" },
        content: "Nice post!",
        publishedAt: 50,
      },
    ]);
  });

  it("assigns the same id across re-verification (keyed on source+target)", async () => {
    const inbox = createD1Inbox(db, { table: "wm_stable_id" });
    const mention = {
      source: "https://a.example/p",
      target: "https://example.com/x",
    };
    await inbox.store({ ...mention, verifiedAt: 1 });
    const first = (await inbox.list())[0]?.id;
    await inbox.store({ ...mention, verifiedAt: 2 });
    const second = (await inbox.list())[0]?.id;
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("rejects an unsafe table name", () => {
    expect(() => createD1Inbox(db, { table: "bad name;" })).toThrow();
  });
});
