import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createD1SentLog } from "./sent-log.js";

interface TestEnv {
  WEBMENTION_INBOX: import("@cloudflare/workers-types").D1Database;
}

const db = (env as unknown as TestEnv).WEBMENTION_INBOX;

describe("createD1SentLog", () => {
  it("creates its table on first use, records, lists, and removes", async () => {
    const log = createD1SentLog(db, { table: "wm_sent_basic" });
    await log.record("https://me.example/p", "https://a.example/", 1000);
    await log.record("https://me.example/p", "https://b.example/", 2000);
    await log.record("https://me.example/q", "https://c.example/", 500);

    expect(await log.listTargets("https://me.example/p")).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);

    await log.remove("https://me.example/p", "https://a.example/");
    expect(await log.listTargets("https://me.example/p")).toEqual([
      "https://b.example/",
    ]);
    // Other sources' rows are untouched.
    expect(await log.listTargets("https://me.example/q")).toEqual([
      "https://c.example/",
    ]);
  });

  it("upserts on the (source, target) pair", async () => {
    const log = createD1SentLog(db, { table: "wm_sent_upsert" });
    await log.record("https://me.example/p", "https://a.example/", 1000);
    await log.record("https://me.example/p", "https://a.example/", 2000);
    expect(await log.listTargets("https://me.example/p")).toEqual([
      "https://a.example/",
    ]);
  });

  it("removing an absent pair is a no-op", async () => {
    const log = createD1SentLog(db, { table: "wm_sent_noop" });
    await expect(
      log.remove("https://me.example/p", "https://a.example/"),
    ).resolves.toBeUndefined();
  });

  it("rejects an unsafe table identifier", () => {
    expect(() => createD1SentLog(db, { table: "bad; DROP" })).toThrow(
      /invalid sent-log table name/,
    );
  });
});
