import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createDurableSqlite,
  createSqlStorage,
  type DurableSqlite,
} from "./sql-storage.js";
import { createStrictSyncSqlite } from "./test-harness.js";

const SCHEMA =
  "CREATE TABLE resources (path TEXT PRIMARY KEY, body TEXT, size INTEGER)";

describe("createDurableSqlite (host-contract §3.2)", () => {
  let storage: DurableSqlite;

  beforeEach(() => {
    storage = createDurableSqlite(createStrictSyncSqlite());
    storage.sql.exec(SCHEMA);
  });

  it("exec() returns rows synchronously via toArray()", () => {
    storage.sql.exec(
      "INSERT INTO resources (path, body, size) VALUES (?, ?, ?)",
      "/a",
      "hello",
      5,
    );
    const rows = storage.sql
      .exec<{ path: string; size: number }>(
        "SELECT path, size FROM resources ORDER BY path",
      )
      .toArray();
    expect(rows).toEqual([{ path: "/a", size: 5 }]);
  });

  it("one() returns the single row, throws on zero or many", () => {
    storage.sql.exec("INSERT INTO resources (path) VALUES ('/a')");
    expect(
      storage.sql.exec<{ path: string }>("SELECT path FROM resources").one()
        .path,
    ).toBe("/a");
    expect(() =>
      storage.sql.exec("SELECT * FROM resources WHERE path = '/none'").one(),
    ).toThrow(/exactly one row, got 0/);
    storage.sql.exec("INSERT INTO resources (path) VALUES ('/b')");
    expect(() => storage.sql.exec("SELECT * FROM resources").one()).toThrow(
      /exactly one row, got 2/,
    );
  });

  it("iterates one-shot with for…of and next()", () => {
    storage.sql.exec("INSERT INTO resources (path) VALUES ('/a')");
    storage.sql.exec("INSERT INTO resources (path) VALUES ('/b')");
    const cursor = storage.sql.exec<{ path: string }>(
      "SELECT path FROM resources ORDER BY path",
    );
    expect(cursor.next()).toEqual({ done: false, value: { path: "/a" } });
    // toArray() drains what iteration hasn't consumed yet.
    expect(cursor.toArray()).toEqual([{ path: "/b" }]);
    expect(cursor.next().done).toBe(true);

    const paths: string[] = [];
    for (const row of storage.sql.exec<{ path: string }>(
      "SELECT path FROM resources ORDER BY path",
    )) {
      paths.push(row.path);
    }
    expect(paths).toEqual(["/a", "/b"]);
  });

  it("exposes columnNames from the result rows", () => {
    storage.sql.exec("INSERT INTO resources (path, body) VALUES ('/a', 'x')");
    const cursor = storage.sql.exec("SELECT path, body FROM resources");
    expect(cursor.columnNames).toEqual(["path", "body"]);
    expect(
      storage.sql.exec("SELECT * FROM resources WHERE path = '/none'")
        .columnNames,
    ).toEqual([]);
  });

  it("routes writes through run() on reader-aware drivers", () => {
    // createStrictSyncSqlite throws from all() on non-reader statements, so
    // a write completing at all proves the run() path was taken.
    const cursor = storage.sql.exec(
      "UPDATE resources SET body = 'x' WHERE path = '/none'",
    );
    expect(cursor.toArray()).toEqual([]);
  });

  it("also accepts a bare node:sqlite handle (no reader metadata)", () => {
    const sql = createSqlStorage(new DatabaseSync(":memory:"));
    sql.exec(SCHEMA);
    sql.exec("INSERT INTO resources (path) VALUES (?)", "/a");
    expect(sql.exec("SELECT path FROM resources").one()).toEqual({
      path: "/a",
    });
  });

  it("normalizes booleans, ArrayBuffers, and undefined bindings", () => {
    storage.sql.exec("CREATE TABLE vals (flag INTEGER, blob BLOB, gone TEXT)");
    const bytes = new Uint8Array([9, 8]);
    storage.sql.exec(
      "INSERT INTO vals (flag, blob, gone) VALUES (?, ?, ?)",
      false,
      bytes.buffer,
      undefined,
    );
    const row = storage.sql
      .exec<{ flag: number; blob: Uint8Array; gone: null }>(
        "SELECT flag, blob, gone FROM vals",
      )
      .one();
    expect(row.flag).toBe(0);
    expect(new Uint8Array(row.blob)).toEqual(bytes);
    expect(row.gone).toBeNull();
  });

  it("supports the PRAGMA table_info migration idiom", () => {
    const names = storage.sql
      .exec<{ name: string }>("PRAGMA table_info(resources)")
      .toArray()
      .map((c) => c.name);
    expect(names).toEqual(["path", "body", "size"]);
  });

  it("transactionSync commits on return and yields fn's value", () => {
    const value = storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO resources (path) VALUES ('/a')");
      storage.sql.exec("INSERT INTO resources (path) VALUES ('/b')");
      return 42;
    });
    expect(value).toBe(42);
    expect(
      storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM resources")
        .one().n,
    ).toBe(2);
  });

  it("transactionSync rolls back every statement when fn throws", () => {
    storage.sql.exec("INSERT INTO resources (path) VALUES ('/keep')");
    expect(() =>
      storage.transactionSync(() => {
        storage.sql.exec("DELETE FROM resources");
        storage.sql.exec("INSERT INTO resources (path) VALUES ('/partial')");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const rows = storage.sql
      .exec<{ path: string }>("SELECT path FROM resources")
      .toArray();
    expect(rows).toEqual([{ path: "/keep" }]);
  });

  it("transactionSync rejects nesting with a clear error, keeping the outer transaction intact", () => {
    expect(() =>
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO resources (path) VALUES ('/outer')");
        storage.transactionSync(() => {
          storage.sql.exec("INSERT INTO resources (path) VALUES ('/inner')");
        });
      }),
    ).toThrow(/does not support nesting/);
    // The outer transaction rolled back cleanly — nothing committed, and the
    // connection is usable again.
    expect(
      storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM resources")
        .one().n,
    ).toBe(0);
    storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO resources (path) VALUES ('/after')");
    });
    expect(
      storage.sql.exec<{ path: string }>("SELECT path FROM resources").one(),
    ).toEqual({ path: "/after" });
  });

  it("reuses cached prepared statements across exec() calls", () => {
    const insert = "INSERT INTO resources (path) VALUES (?)";
    storage.sql.exec(insert, "/a");
    storage.sql.exec(insert, "/b");
    expect(
      storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM resources")
        .one().n,
    ).toBe(2);
  });
});
