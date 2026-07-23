import { describe, it, expect, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createD1Database } from "./d1.js";
import {
  createFakeLibsqlClient,
  type FakeLibsqlClient,
} from "./test-harness.js";

describe("createD1Database (host-contract §3.5)", () => {
  let client: FakeLibsqlClient;
  let db: D1Database;

  beforeEach(async () => {
    client = createFakeLibsqlClient();
    db = createD1Database(client);
    await db.exec(
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, slug TEXT UNIQUE, body TEXT)",
    );
  });

  it("first() returns the first row as a plain object, null when empty", async () => {
    await db
      .prepare("INSERT INTO notes (slug, body) VALUES (?, ?)")
      .bind("a", "hello")
      .run();
    const row = await db
      .prepare("SELECT slug, body FROM notes WHERE slug = ?")
      .bind("a")
      .first<{ slug: string; body: string }>();
    expect(row).toEqual({ slug: "a", body: "hello" });
    // A plain object: no array-like hybrid keys leaked from the client row.
    expect(Object.keys(row as object)).toEqual(["slug", "body"]);
    expect(
      await db
        .prepare("SELECT * FROM notes WHERE slug = ?")
        .bind("nope")
        .first(),
    ).toBeNull();
  });

  it("first(colName) returns a single column, null when absent", async () => {
    await db.prepare("INSERT INTO notes (slug, body) VALUES ('a', 'x')").run();
    expect(
      await db.prepare("SELECT body FROM notes WHERE slug = 'a'").first("body"),
    ).toBe("x");
    expect(
      await db
        .prepare("SELECT NULL AS body FROM notes WHERE slug = 'a'")
        .first("body"),
    ).toBeNull();
  });

  it("all() returns the { results, success, meta } envelope", async () => {
    await db.prepare("INSERT INTO notes (slug, body) VALUES ('a', '1')").run();
    await db.prepare("INSERT INTO notes (slug, body) VALUES ('b', '2')").run();
    const out = await db
      .prepare("SELECT slug FROM notes ORDER BY slug")
      .all<{ slug: string }>();
    expect(out.success).toBe(true);
    expect(out.results).toEqual([{ slug: "a" }, { slug: "b" }]);
    expect(out.meta).toBeDefined();
  });

  it("run() reports meta.changes — the INSERT OR IGNORE dedup branch", async () => {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO notes (slug, body) VALUES (?, ?)",
    );
    const first = await insert.bind("dup", "x").run();
    expect(first.meta.changes).toBe(1);
    expect(first.meta.last_row_id).toBeGreaterThan(0);
    const second = await insert.bind("dup", "x").run();
    expect(second.meta.changes).toBe(0);
  });

  it("run() reports meta.changes for conditional UPDATEs", async () => {
    await db
      .prepare("INSERT INTO notes (slug, body) VALUES ('a', 'old')")
      .run();
    const hit = await db
      .prepare("UPDATE notes SET body = 'new' WHERE slug = ?")
      .bind("a")
      .run();
    expect(hit.meta.changes).toBe(1);
    const miss = await db
      .prepare("UPDATE notes SET body = 'new' WHERE slug = ?")
      .bind("missing")
      .run();
    expect(miss.meta.changes).toBe(0);
  });

  it("read-your-writes: a query after a completed write observes it", async () => {
    await db
      .prepare("INSERT INTO notes (slug, body) VALUES ('ryw', 'v')")
      .run();
    const row = await db
      .prepare("SELECT body FROM notes WHERE slug = 'ryw'")
      .first("body");
    expect(row).toBe("v");
  });

  it("batch() executes atomically and in order, one envelope per statement", async () => {
    const results = await db.batch([
      db.prepare("INSERT INTO notes (slug, body) VALUES ('b1', 'x')"),
      db.prepare("UPDATE notes SET body = 'y' WHERE slug = 'b1'"),
      db.prepare("SELECT body FROM notes WHERE slug = 'b1'"),
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]?.meta.changes).toBe(1);
    expect(results[1]?.meta.changes).toBe(1);
    expect(results[2]?.results).toEqual([{ body: "y" }]);
  });

  it("batch() is all-or-nothing: a failing statement rolls back the rest", async () => {
    await db
      .prepare("INSERT INTO notes (slug, body) VALUES ('keep', 'x')")
      .run();
    await expect(
      db.batch([
        db.prepare("INSERT INTO notes (slug, body) VALUES ('gone', 'x')"),
        // UNIQUE violation on slug.
        db.prepare("INSERT INTO notes (slug, body) VALUES ('keep', 'x')"),
      ]),
    ).rejects.toThrow();
    const rows = await db
      .prepare("SELECT slug FROM notes ORDER BY slug")
      .all<{ slug: string }>();
    expect(rows.results).toEqual([{ slug: "keep" }]);
  });

  it("batch() rejects statements from a foreign prepare()", async () => {
    await expect(
      db.batch([{ ok: false } as unknown as ReturnType<D1Database["prepare"]>]),
    ).rejects.toThrow(/prepare/);
  });

  it("exec() runs ;-separated statements and counts them", async () => {
    const out = await db.exec(
      "CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);",
    );
    expect(out.count).toBe(2);
    await db.prepare("INSERT INTO a (id) VALUES (1)").run();
    await db.prepare("INSERT INTO b (id) VALUES (2)").run();
  });

  it("raw() returns value arrays, optionally prefixed with column names", async () => {
    await db.prepare("INSERT INTO notes (slug, body) VALUES ('a', '1')").run();
    const values = await db
      .prepare("SELECT slug, body FROM notes")
      .raw<[string, string]>();
    expect(values).toEqual([["a", "1"]]);
    const withNames = await db
      .prepare("SELECT slug, body FROM notes")
      .raw({ columnNames: true });
    expect(withNames).toEqual([
      ["slug", "body"],
      ["a", "1"],
    ]);
  });

  it("exec() does not count semicolons inside string literals", async () => {
    await db.exec("CREATE TABLE lits (v TEXT)");
    const out = await db.exec("INSERT INTO lits (v) VALUES ('a;b')");
    expect(out.count).toBe(1);
    expect(await db.prepare("SELECT v FROM lits").first("v")).toBe("a;b");
  });

  it("dump() and withSession() fail loudly as not implemented", async () => {
    await expect(db.dump()).rejects.toThrow(/not implemented/);
    expect(() => db.withSession()).toThrow(/not implemented/);
  });

  it("supports the PRAGMA table_info migration idiom", async () => {
    const cols = await db
      .prepare("PRAGMA table_info(notes)")
      .all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual(["id", "slug", "body"]);
  });

  it("binds ?N numbered placeholders positionally", async () => {
    await db
      .prepare("INSERT INTO notes (slug, body) VALUES (?1, ?2)")
      .bind("n1", "b1")
      .run();
    const row = await db
      .prepare("SELECT body FROM notes WHERE slug = ?1")
      .bind("n1")
      .first("body");
    expect(row).toBe("b1");
  });

  it("normalizes booleans, ArrayBuffers, and undefined bindings", async () => {
    await db.exec("CREATE TABLE vals (flag INTEGER, blob BLOB, gone TEXT)");
    const bytes = new Uint8Array([1, 2, 3]);
    await db
      .prepare("INSERT INTO vals (flag, blob, gone) VALUES (?, ?, ?)")
      .bind(true, bytes.buffer, undefined)
      .run();
    const row = await db
      .prepare("SELECT flag, blob, gone FROM vals")
      .first<{ flag: number; blob: Uint8Array; gone: null }>();
    expect(row?.flag).toBe(1);
    expect(new Uint8Array(row?.blob as Uint8Array)).toEqual(bytes);
    expect(row?.gone).toBeNull();
  });

  it("rejects unsupported binding types", () => {
    expect(() =>
      db.prepare("SELECT ?").bind({ nested: true } as unknown as string),
    ).toThrow(TypeError);
  });
});
