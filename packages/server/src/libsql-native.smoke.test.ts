/**
 * Native-module smoke test (spec/scale-out.md §6.2, issue #432's "verify
 * early" carve-out): confirms the `libsql` npm package's embedded-replica
 * client — a native addon — actually loads and runs under this repo's Node
 * version, and that its `Database` instance is structurally assignable to
 * `EmbeddedReplicaClientLike` (the shape `central-durable-object.ts` needs).
 *
 * `@dwk/server` never depends on `libsql` at runtime (`getStorageClient` is
 * always deployer-injected, same as every other `@dwk/deno-host` seam), so
 * this is a `devDependency`-only check, not a production code path — this
 * file is the one place in the package that imports it. Deliberately does
 * NOT open a real embedded replica against a live libSQL/Turso primary
 * (`syncUrl`): that live-service verification is explicitly out of scope for
 * this issue (spec/scale-out.md's "Out of scope" list) and belongs with
 * `spec/packages/deno-host.md`'s other live-verification items. This only
 * proves the native module itself loads and behaves as a local, unreplicated
 * SQLite database — `sync()` is present but is not expected to do anything
 * meaningful without a configured primary.
 */

import { describe, it, expect } from "vitest";
import Database from "libsql";
import type { EmbeddedReplicaClientLike } from "./central-durable-object.js";

describe("libsql native module (Node, no live primary)", () => {
  it("loads, opens an in-memory database, and round-trips a row", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(1, "hello");
      const row = db.prepare("SELECT v FROM t WHERE id = 1").get() as {
        v: string;
      };
      expect(row.v).toBe("hello");
    } finally {
      db.close();
    }
  });

  it("is structurally assignable to EmbeddedReplicaClientLike (exec/prepare/sync)", () => {
    const db = new Database(":memory:");
    try {
      const client: EmbeddedReplicaClientLike = db;
      client.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      const stmt = client.prepare("INSERT INTO t (id) VALUES (1)");
      expect(typeof stmt.all).toBe("function");
      expect(typeof stmt.run).toBe("function");
      expect(typeof client.sync).toBe("function");
    } finally {
      db.close();
    }
  });
});
