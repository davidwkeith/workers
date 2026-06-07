import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createD1Database } from "./d1";
import type { D1Database } from "@cloudflare/workers-types";

describe("D1 → node:sqlite shim", () => {
  let db: D1Database;

  beforeEach(async () => {
    db = createD1Database(":memory:");
    await db.exec(
      "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, body TEXT, n INTEGER);",
    );
  });

  it("inserts and reads back via first()", async () => {
    const run = await db
      .prepare("INSERT INTO notes (slug, body, n) VALUES (?, ?, ?)")
      .bind("a", "hello", 1)
      .run();
    expect(run.success).toBe(true);
    expect(run.meta.changes).toBe(1);
    expect(run.meta.last_row_id).toBe(1);

    const row = await db
      .prepare("SELECT slug, body, n FROM notes WHERE slug = ?")
      .bind("a")
      .first<{ slug: string; body: string; n: number }>();
    expect(row).toEqual({ slug: "a", body: "hello", n: 1 });
  });

  it("first(column) returns the scalar value, or null when absent", async () => {
    await db
      .prepare("INSERT INTO notes (slug, n) VALUES (?, ?)")
      .bind("a", 7)
      .run();
    const n = await db
      .prepare("SELECT n FROM notes WHERE slug = ?")
      .bind("a")
      .first<number>("n");
    expect(n).toBe(7);
    const missing = await db
      .prepare("SELECT n FROM notes WHERE slug = ?")
      .bind("nope")
      .first<number>("n");
    expect(missing).toBeNull();
  });

  it("all() returns the { results, success, meta } envelope", async () => {
    await db
      .prepare("INSERT INTO notes (slug, n) VALUES (?, ?)")
      .bind("a", 1)
      .run();
    await db
      .prepare("INSERT INTO notes (slug, n) VALUES (?, ?)")
      .bind("b", 2)
      .run();
    const result = await db
      .prepare("SELECT slug FROM notes ORDER BY slug")
      .all<{ slug: string }>();
    expect(result.success).toBe(true);
    expect(result.results).toEqual([{ slug: "a" }, { slug: "b" }]);
  });

  it("reports meta.changes 0 for an ignored conflicting insert", async () => {
    await db
      .prepare("INSERT INTO notes (slug, n) VALUES (?, ?)")
      .bind("a", 1)
      .run();
    const second = await db
      .prepare("INSERT OR IGNORE INTO notes (slug, n) VALUES (?, ?)")
      .bind("a", 9)
      .run();
    expect(second.meta.changes).toBe(0);
  });

  it("batch() is atomic and reports per-statement meta", async () => {
    const results = await db.batch([
      db.prepare("INSERT INTO notes (slug, n) VALUES (?, ?)").bind("x", 1),
      db.prepare("INSERT INTO notes (slug, n) VALUES (?, ?)").bind("y", 2),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.meta.changes).toBe(1);
    expect(results[1]?.meta.changes).toBe(1);

    await expect(
      db.batch([
        db.prepare("INSERT INTO notes (slug, n) VALUES (?, ?)").bind("z", 3),
        // Duplicate slug violates UNIQUE → whole batch rolls back.
        db.prepare("INSERT INTO notes (slug, n) VALUES (?, ?)").bind("x", 4),
      ]),
    ).rejects.toThrow();
    const z = await db
      .prepare("SELECT slug FROM notes WHERE slug = 'z'")
      .first();
    expect(z).toBeNull();
  });

  it("supports PRAGMA table_info via all()", async () => {
    const info = await db
      .prepare("PRAGMA table_info(notes)")
      .all<{ name: string }>();
    expect(info.results.map((r) => r.name)).toContain("slug");
  });

  it("binds null values", async () => {
    await db
      .prepare("INSERT INTO notes (slug, body) VALUES (?, ?)")
      .bind("a", null)
      .run();
    const row = await db
      .prepare("SELECT body FROM notes WHERE slug = 'a'")
      .first<{ body: string | null }>();
    expect(row?.body).toBeNull();
  });

  it("persists across reopening the same file (read-your-writes)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dwk-d1-"));
    const path = join(dir, "data.sqlite");
    const first = createD1Database(path);
    await first.exec("CREATE TABLE t (k TEXT PRIMARY KEY);");
    await first.prepare("INSERT INTO t (k) VALUES (?)").bind("v").run();

    const reopened = createD1Database(path);
    const row = await reopened
      .prepare("SELECT k FROM t")
      .first<{ k: string }>();
    expect(row?.k).toBe("v");
  });
});
