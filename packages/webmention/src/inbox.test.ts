import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createD1Inbox } from "./inbox";

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

  it("rejects an unsafe table name", () => {
    expect(() => createD1Inbox(db, { table: "bad name;" })).toThrow();
  });
});
