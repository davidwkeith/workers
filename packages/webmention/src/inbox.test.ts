import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createD1Inbox, mentionId } from "./inbox.js";

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
        id: mentionId("https://a.example/p", "https://example.com/x"),
        source: "https://a.example/p",
        target: "https://example.com/x",
        verifiedAt: 1000,
        // A mention stored without enrichment defaults its type and falls its
        // published time back to the verification time.
        interactionType: "mention",
        publishedAt: 1000,
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
    const all = await inbox.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.rsvp).toBe("yes");
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

  it("round-trips enrichment: interaction type, author, content, published", async () => {
    const inbox = createD1Inbox(db, { table: "wm_enriched" });
    await inbox.store({
      source: "https://a.example/reply",
      target: "https://example.com/post",
      verifiedAt: 100,
      interactionType: "reply",
      author: {
        name: "The Author",
        url: "https://a.example/",
        photo: "https://a.example/avatar.png",
      },
      content:
        '<p>Nice <a href="https://x.example/" rel="ugc nofollow">post</a></p>',
      publishedAt: 42,
    });
    expect(await inbox.list()).toEqual([
      {
        id: mentionId("https://a.example/reply", "https://example.com/post"),
        source: "https://a.example/reply",
        target: "https://example.com/post",
        verifiedAt: 100,
        interactionType: "reply",
        author: {
          name: "The Author",
          url: "https://a.example/",
          photo: "https://a.example/avatar.png",
        },
        content:
          '<p>Nice <a href="https://x.example/" rel="ugc nofollow">post</a></p>',
        publishedAt: 42,
      },
    ]);
  });

  it("migrates a pre-enrichment table additively and derives missing ids", async () => {
    // An inbox created before any of the added columns existed…
    await db
      .prepare(
        "CREATE TABLE wm_legacy (source TEXT NOT NULL, target TEXT NOT NULL, " +
          "verified_at INTEGER NOT NULL, PRIMARY KEY (source, target))",
      )
      .run();
    // …with a row stored by that old code.
    await db
      .prepare(
        "INSERT INTO wm_legacy (source, target, verified_at) VALUES (?1, ?2, ?3)",
      )
      .bind("https://old.example/p", "https://example.com/x", 7)
      .run();

    const inbox = createD1Inbox(db, { table: "wm_legacy" });
    const all = await inbox.list();
    expect(all).toEqual([
      {
        id: mentionId("https://old.example/p", "https://example.com/x"),
        source: "https://old.example/p",
        target: "https://example.com/x",
        verifiedAt: 7,
        interactionType: "mention",
        publishedAt: 7,
      },
    ]);

    // And the migrated table accepts enriched writes.
    await inbox.store({
      source: "https://new.example/like",
      target: "https://example.com/x",
      verifiedAt: 8,
      interactionType: "like",
      author: { name: "Liker" },
      publishedAt: 8,
    });
    const liked = (await inbox.list()).find(
      (m) => m.source === "https://new.example/like",
    );
    expect(liked?.interactionType).toBe("like");
    expect(liked?.author).toEqual({ name: "Liker" });
  });

  it("rejects an unsafe table name", () => {
    expect(() => createD1Inbox(db, { table: "bad name;" })).toThrow();
  });

  it("persists and lists a vouch outcome", async () => {
    const inbox = createD1Inbox(db, { table: "wm_vouch" });
    await inbox.store({
      source: "https://a.example/vouch",
      target: "https://example.com/x",
      verifiedAt: 1,
      vouch: { url: "https://trusted.example/", verified: true },
    });
    const all = await inbox.list();
    expect(all[0]?.vouch).toEqual({
      url: "https://trusted.example/",
      verified: true,
    });
  });

  it("distinguishes a failed vouch attempt from no vouch at all", async () => {
    const inbox = createD1Inbox(db, { table: "wm_vouch_failed" });
    await inbox.store({
      source: "https://a.example/vouch",
      target: "https://example.com/x",
      verifiedAt: 1,
      vouch: { url: "https://untrusted.example/", verified: false },
    });
    const all = await inbox.list();
    expect(all[0]?.vouch).toEqual({
      url: "https://untrusted.example/",
      verified: false,
    });
  });

  it("omits vouch on a mention stored without one", async () => {
    const inbox = createD1Inbox(db, { table: "wm_no_vouch" });
    await inbox.store({
      source: "https://a.example/p",
      target: "https://example.com/x",
      verifiedAt: 1,
    });
    const all = await inbox.list();
    expect(all[0]?.vouch).toBeUndefined();
  });

  it("migrates a pre-vouch table additively", async () => {
    // A table created by a @dwk/webmention version before vouch support
    // existed — has every enrichment column except vouch_url/vouch_verified.
    await db
      .prepare(
        "CREATE TABLE wm_pre_vouch (source TEXT NOT NULL, target TEXT NOT NULL, " +
          "verified_at INTEGER NOT NULL, rsvp TEXT, id TEXT, interaction_type TEXT, " +
          "author_name TEXT, author_url TEXT, author_photo TEXT, content TEXT, " +
          "published_at INTEGER, PRIMARY KEY (source, target))",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO wm_pre_vouch (source, target, verified_at, id) VALUES (?1, ?2, ?3, ?4)",
      )
      .bind(
        "https://old.example/p",
        "https://example.com/x",
        7,
        mentionId("https://old.example/p", "https://example.com/x"),
      )
      .run();

    const inbox = createD1Inbox(db, { table: "wm_pre_vouch" });
    const preExisting = (await inbox.list())[0];
    expect(preExisting?.vouch).toBeUndefined();

    await inbox.store({
      source: "https://new.example/vouched",
      target: "https://example.com/x",
      verifiedAt: 8,
      vouch: { url: "https://trusted.example/", verified: true },
    });
    const vouched = (await inbox.list()).find(
      (m) => m.source === "https://new.example/vouched",
    );
    expect(vouched?.vouch).toEqual({
      url: "https://trusted.example/",
      verified: true,
    });
  });
});
