import { describe, expect, it, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createD1Database, createR2Bucket, QueueBroker } from "@dwk/cf-shims";
import {
  createQueueBroker,
  createS3Bucket,
  getAlarm,
  setAlarm,
  createD1Database as createCentralD1Database,
} from "@dwk/deno-host";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { LibsqlKv } from "./libsql-kv.js";
import {
  createFakeLibsqlClient,
  FakeS3Client,
} from "./central-test-harness.js";
import {
  dumpLocalSqlite,
  replayIntoLocalSqlite,
  migrateD1ToCentral,
  migrateD1ToLocal,
  migrateDoObjectToCentral,
  migrateDoObjectToLocal,
  migrateR2ToCentral,
  migrateR2ToLocal,
  importQueueBacklog,
  migrateLocalToCentral,
  migrateCentralToLocal,
  parseMigrateArgs,
  main,
  liftPendingAlarm,
} from "./migrate.js";

const dirs: string[] = [];

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-migrate-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("SQLite dump/replay", () => {
  it("round-trips schema, rows, and an index through a fresh file", () => {
    const dir = workdir();
    const src = join(dir, "src.sqlite");
    const db = new DatabaseSync(src);
    db.exec(
      "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL); " +
        "CREATE INDEX idx_t_name ON t (name);",
    );
    db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(1, "alice");
    db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(2, "bob");
    db.close();

    const dump = dumpLocalSqlite(src);
    expect(dump.tables).toHaveLength(1);
    expect(dump.tables[0]?.rows).toHaveLength(2);
    expect(dump.ddl.some((d) => d.includes("idx_t_name"))).toBe(true);

    const dst = join(dir, "dst.sqlite");
    replayIntoLocalSqlite(dst, dump);
    const replayed = new DatabaseSync(dst, { readOnly: true });
    const rows = replayed
      .prepare("SELECT id, name FROM t ORDER BY id")
      .all() as { id: number; name: string }[];
    replayed.close();
    expect(rows).toEqual([
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ]);
  });

  it("excludes named tables from the dump", () => {
    const dir = workdir();
    const src = join(dir, "src.sqlite");
    const db = new DatabaseSync(src);
    db.exec(
      "CREATE TABLE keep (k TEXT); CREATE TABLE _host_alarm (id INTEGER PRIMARY KEY CHECK (id = 1), scheduled_time INTEGER NOT NULL);",
    );
    db.close();
    const dump = dumpLocalSqlite(src, { excludeTables: ["_host_alarm"] });
    expect(dump.tables.map((t) => t.name)).toEqual(["keep"]);
  });
});

describe("D1 migration", () => {
  it("migrates a local D1 file to a central libSQL client and back", async () => {
    const dir = workdir();
    const localPath = join(dir, "d1", "AUTH_DB.sqlite");
    const local = createD1Database(localPath) as D1Database;
    await local.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)");
    await local
      .prepare("INSERT INTO users VALUES (?, ?)")
      .bind("u1", "Alice")
      .run();

    const client = createFakeLibsqlClient();
    const report = await migrateD1ToCentral(localPath, client);
    expect(report).toEqual({ tables: 1, rows: 1 });

    const centralDb = createCentralD1Database(client);
    const row = await centralDb
      .prepare("SELECT name FROM users WHERE id = ?")
      .bind("u1")
      .first<{ name: string }>();
    expect(row?.name).toBe("Alice");

    // Round-trip back to a fresh local file.
    const backPath = join(dir, "d1-back", "AUTH_DB.sqlite");
    const backReport = await migrateD1ToLocal(client, backPath);
    expect(backReport).toEqual({ tables: 1, rows: 1 });
    const back = createD1Database(backPath) as D1Database;
    const backRow = await back
      .prepare("SELECT name FROM users WHERE id = ?")
      .bind("u1")
      .first<{ name: string }>();
    expect(backRow?.name).toBe("Alice");
  });
});

describe("Durable Object migration + pending alarms", () => {
  it("migrates DO data and lifts a pending alarm into central KV", async () => {
    const dir = workdir();
    const localPath = join(dir, "do", "SolidPodObject", "abc123.sqlite");
    mkdirSync(dirname(localPath), { recursive: true });
    const db = new DatabaseSync(localPath);
    db.exec(
      "CREATE TABLE resources (path TEXT PRIMARY KEY, body TEXT); " +
        "CREATE TABLE _host_alarm (id INTEGER PRIMARY KEY CHECK (id = 1), scheduled_time INTEGER NOT NULL);",
    );
    db.prepare("INSERT INTO resources VALUES (?, ?)").run("/x", "hello");
    db.prepare(
      "INSERT INTO _host_alarm (id, scheduled_time) VALUES (1, ?)",
    ).run(1234567890);
    db.close();

    const kv = new LibsqlKv(createFakeLibsqlClient());
    const storage = new DatabaseSync(":memory:");
    const report = await migrateDoObjectToCentral(
      localPath,
      storage,
      kv,
      "SolidPodObject",
      "abc123",
    );
    expect(report.tables).toBe(1); // resources only; _host_alarm excluded
    expect(report.rows).toBe(1);
    expect(report.alarmLifted).toBe(true);

    const centralRow = storage
      .prepare("SELECT body FROM resources WHERE path = ?")
      .get("/x") as { body: string } | undefined;
    expect(centralRow?.body).toBe("hello");

    const alarm = await getAlarm(kv, "SolidPodObject", "abc123");
    expect(alarm).toBe(1234567890);
  });

  it("reports alarmLifted: false when no alarm was pending", async () => {
    const dir = workdir();
    const localPath = join(dir, "do", "SolidPodObject", "noalarm.sqlite");
    mkdirSync(dirname(localPath), { recursive: true });
    const db = new DatabaseSync(localPath);
    db.exec("CREATE TABLE resources (path TEXT PRIMARY KEY)");
    db.close();

    const kv = new LibsqlKv(createFakeLibsqlClient());
    const lifted = await liftPendingAlarm(
      localPath,
      kv,
      "SolidPodObject",
      "noalarm",
    );
    expect(lifted).toBe(false);
  });

  it("migrates central DO storage back to a local file and lowers the alarm", async () => {
    const kv = new LibsqlKv(createFakeLibsqlClient());
    const storage = new DatabaseSync(":memory:");
    storage.exec("CREATE TABLE resources (path TEXT PRIMARY KEY, body TEXT)");
    storage.prepare("INSERT INTO resources VALUES (?, ?)").run("/y", "world");
    await setAlarm(kv, "SolidPodObject", "def456", 42);

    const dir = workdir();
    const localPath = join(dir, "do", "SolidPodObject", "def456.sqlite");
    const report = await migrateDoObjectToLocal(
      storage,
      localPath,
      kv,
      "SolidPodObject",
      "def456",
    );
    expect(report.rows).toBe(1);
    expect(report.alarmLifted).toBe(true);

    const local = new DatabaseSync(localPath, { readOnly: true });
    const row = local
      .prepare("SELECT body FROM resources WHERE path = ?")
      .get("/y") as { body: string } | undefined;
    const alarmRow = local
      .prepare("SELECT scheduled_time AS t FROM _host_alarm WHERE id = 1")
      .get() as { t: number } | undefined;
    local.close();
    expect(row?.body).toBe("world");
    expect(alarmRow?.t).toBe(42);
  });
});

describe("R2 migration", () => {
  it("migrates local objects to central and back, preserving metadata", async () => {
    const dir = workdir();
    const localRoot = join(dir, "r2", "MEDIA");
    const bucket = createR2Bucket(localRoot) as R2Bucket;
    await bucket.put("images/a.txt", "hello world", {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { alt: "greeting" },
    });

    const s3 = new FakeS3Client();
    const target = { client: s3, endpoint: "https://s3.example.com/media" };
    const report = await migrateR2ToCentral(localRoot, target);
    expect(report.objects).toBe(1);
    expect(report.bytes).toBe(11);

    const centralBucket = createS3Bucket(target);
    const centralObj = await centralBucket.get("images/a.txt");
    expect(await centralObj?.text()).toBe("hello world");
    expect(centralObj?.httpMetadata?.contentType).toBe("text/plain");
    expect(centralObj?.customMetadata?.["alt"]).toBe("greeting");

    // And back to a fresh local root.
    const backRoot = join(dir, "r2-back", "MEDIA");
    const backReport = await migrateR2ToLocal(target, backRoot, [
      "images/a.txt",
    ]);
    expect(backReport.objects).toBe(1);
    const backBucket = createR2Bucket(backRoot) as R2Bucket;
    const backObj = await backBucket.get("images/a.txt");
    expect(await backObj?.text()).toBe("hello world");
    expect(backObj?.httpMetadata?.contentType).toBe("text/plain");
  });

  it("skips keys the central bucket doesn't have when migrating to local", async () => {
    const dir = workdir();
    const target = {
      client: new FakeS3Client(),
      endpoint: "https://s3.example.com/media",
    };
    const report = await migrateR2ToLocal(target, join(dir, "r2"), [
      "missing.txt",
    ]);
    expect(report).toEqual({ objects: 0, bytes: 0 });
  });
});

describe("Queue backlog import", () => {
  it("imports non-dead local jobs into central KV as due entries", async () => {
    const dir = workdir();
    const queuePath = join(dir, "queue.sqlite");
    const local = new QueueBroker({ location: queuePath, now: () => 1000 });
    await local.producer("WEBMENTION_RETRY").send({ url: "https://a.example" });
    await local
      .producer("WEBMENTION_RETRY")
      .send({ url: "https://b.example" }, { delaySeconds: 30 });

    const kv = new LibsqlKv(createFakeLibsqlClient());
    const report = await importQueueBacklog(queuePath, kv, { now: () => 1000 });
    expect(report).toEqual({ imported: 2, dropped: 0 });

    const delivered: unknown[] = [];
    const broker = createQueueBroker(kv, { now: () => 1000 });
    broker.consumer("WEBMENTION_RETRY", async (batch) => {
      for (const m of batch.messages) {
        delivered.push(m.body);
        m.ack();
      }
    });
    await broker.pollQueues({ now: 1000 });
    // The immediate message is due now; the delayed one (due at 31000) is not.
    expect(delivered).toEqual([{ url: "https://a.example" }]);
    await broker.pollQueues({ now: 31000 });
    expect(delivered).toEqual([
      { url: "https://a.example" },
      { url: "https://b.example" },
    ]);
  });
});

describe("dataDir-scanning orchestration", () => {
  it("migrates every matched binding and reports unmatched ones as skipped", async () => {
    const dir = workdir();
    // D1
    const authDb = createD1Database(
      join(dir, "d1", "AUTH_DB.sqlite"),
    ) as D1Database;
    await authDb.exec("CREATE TABLE t (k TEXT)");
    await authDb.prepare("INSERT INTO t VALUES (?)").bind("x").run();
    // An unmapped D1 binding.
    const otherDb = createD1Database(
      join(dir, "d1", "UNMAPPED.sqlite"),
    ) as D1Database;
    await otherDb.exec("CREATE TABLE t (k TEXT)");
    // R2
    const media = createR2Bucket(join(dir, "r2", "MEDIA")) as R2Bucket;
    await media.put("a.txt", "hi");
    // DO
    const doPath = join(
      dir,
      "do",
      "SolidPodObject",
      String("a").repeat(8) + ".sqlite",
    );
    mkdirSync(dirname(doPath), { recursive: true });
    const doDb = new DatabaseSync(doPath);
    doDb.exec("CREATE TABLE resources (path TEXT PRIMARY KEY)");
    doDb.close();

    const kv = new LibsqlKv(createFakeLibsqlClient());
    const doStorage = new DatabaseSync(":memory:");
    const report = await migrateLocalToCentral(dir, {
      kv,
      d1: { AUTH_DB: createFakeLibsqlClient() },
      r2: {
        MEDIA: {
          client: new FakeS3Client(),
          endpoint: "https://s3.example.com/media",
        },
      },
      durableObjects: { SolidPodObject: () => doStorage },
    });

    expect(report.d1["AUTH_DB"]).toEqual({ tables: 1, rows: 1 });
    expect(report.r2["MEDIA"]).toEqual({ objects: 1, bytes: 2 });
    expect(report.durableObjects["SolidPodObject"]).toEqual({
      objects: 1,
      alarmsLifted: 0,
    });
    expect(report.skipped).toContain("d1/UNMAPPED.sqlite");
  });

  it("migrateCentralToLocal writes the same on-disk layout bindings.ts expects", async () => {
    const dir = workdir();
    const client = createFakeLibsqlClient();
    const centralDb = createCentralD1Database(client);
    await centralDb.exec("CREATE TABLE t (k TEXT)");
    await centralDb.prepare("INSERT INTO t VALUES (?)").bind("y").run();

    const report = await migrateCentralToLocal(dir, {
      d1: { AUTH_DB: client },
    });
    expect(report.d1["AUTH_DB"]).toEqual({ tables: 1, rows: 1 });

    const local = createD1Database(
      join(dir, "d1", "AUTH_DB.sqlite"),
    ) as D1Database;
    const row = await local.prepare("SELECT k FROM t").first<{ k: string }>();
    expect(row?.k).toBe("y");
  });

  it("migrateCentralToLocal requires kv when migrating durable objects", async () => {
    const storage = new DatabaseSync(":memory:");
    await expect(
      migrateCentralToLocal(workdir(), {
        durableObjects: [{ className: "X", idHex: "aa", storage }],
      }),
    ).rejects.toThrow(/requires source.kv/);
  });
});

describe("CLI arg parsing", () => {
  it("parses direction, config path, and --data-dir", () => {
    expect(
      parseMigrateArgs(["to-central", "./cfg.mjs", "--data-dir", "/data"]),
    ).toEqual({
      direction: "to-central",
      configPath: "./cfg.mjs",
      dataDir: "/data",
    });
    expect(parseMigrateArgs(["to-local", "-d", "/x", "cfg.mjs"])).toEqual({
      direction: "to-local",
      configPath: "cfg.mjs",
      dataDir: "/x",
    });
  });

  it("throws without a direction", () => {
    expect(() => parseMigrateArgs(["./cfg.mjs"])).toThrow(/missing direction/);
  });
});

describe("main (end to end)", () => {
  it("runs a to-central migration from a config module", async () => {
    const dir = workdir();
    const authDb = createD1Database(
      join(dir, "d1", "AUTH_DB.sqlite"),
    ) as D1Database;
    await authDb.exec("CREATE TABLE t (k TEXT)");
    await authDb.prepare("INSERT INTO t VALUES (?)").bind("z").run();

    // The fake client + kv must be reachable from the dynamically-imported
    // config module; stash them on globalThis for the module to pick up.
    (globalThis as Record<string, unknown>).__migrateTestClient =
      createFakeLibsqlClient();
    const configPath = join(dir, "migrate.config.mjs");
    writeFileSync(
      configPath,
      "export default { kv: undefined, d1: { AUTH_DB: globalThis.__migrateTestClient } };",
    );

    const events: { event: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      debug() {},
      info: (event: string, fields?: Record<string, unknown>) =>
        events.push({ event, fields }),
      warn() {},
      error() {},
    };

    const report = await main({
      argv: ["to-central", configPath, "--data-dir", dir],
      logger,
    });
    expect(report.d1["AUTH_DB"]).toEqual({ tables: 1, rows: 1 });
    expect(events.some((e) => e.event === "migrate.start")).toBe(true);
    expect(events.some((e) => e.event === "migrate.done")).toBe(true);
  });
});
