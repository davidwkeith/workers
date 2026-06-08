import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleBindings } from "./bindings";
import type {
  D1Database,
  R2Bucket,
  KVNamespace,
} from "@cloudflare/workers-types";

const tempDirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwk-bind-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe("assembleBindings", () => {
  it("creates a working D1 database persisted under d1/<name>.sqlite", async () => {
    const dir = dataDir();
    const env = assembleBindings({ dataDir: dir, d1: ["AUTH_DB"] });
    const db = env.AUTH_DB as D1Database;
    await db.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)");
    await db.prepare("INSERT INTO t VALUES (?, ?)").bind("a", "1").run();
    const row = await db
      .prepare("SELECT v FROM t WHERE k = ?")
      .bind("a")
      .first<{
        v: string;
      }>();
    expect(row?.v).toBe("1");
    expect(existsSync(join(dir, "d1", "AUTH_DB.sqlite"))).toBe(true);
  });

  it("creates a working R2 bucket rooted at r2/<name>/", async () => {
    const dir = dataDir();
    const env = assembleBindings({ dataDir: dir, r2: ["MEDIA"] });
    const bucket = env.MEDIA as R2Bucket;
    await bucket.put("hello.txt", "hi");
    const got = await bucket.get("hello.txt");
    expect(await got?.text()).toBe("hi");
    expect(existsSync(join(dir, "r2", "MEDIA"))).toBe(true);
  });

  it("persists a KV namespace to disk by default, memory when asked", async () => {
    const dir = dataDir();
    const env = assembleBindings({
      dataDir: dir,
      kv: ["DISK_CACHE", { name: "MEM_CACHE", memory: true }],
    });
    await (env.DISK_CACHE as KVNamespace).put("k", "v");
    await (env.MEM_CACHE as KVNamespace).put("k", "v");
    expect(existsSync(join(dir, "kv", "DISK_CACHE.sqlite"))).toBe(true);
    expect(existsSync(join(dir, "kv", "MEM_CACHE.sqlite"))).toBe(false);
  });

  it("injects secrets and skips undefined ones", () => {
    const env = assembleBindings({
      dataDir: dataDir(),
      secrets: { TOKEN_SIGNING_KEY: "shh", ABSENT: undefined },
    });
    expect(env.TOKEN_SIGNING_KEY).toBe("shh");
    expect("ABSENT" in env).toBe(false);
  });

  it("rejects a binding name unsafe as a path component", () => {
    expect(() =>
      assembleBindings({ dataDir: dataDir(), d1: ["../escape"] }),
    ).toThrow(/invalid D1 binding name/);
    expect(() => assembleBindings({ dataDir: dataDir(), r2: ["a/b"] })).toThrow(
      /invalid R2 binding name/,
    );
  });

  it("rejects two bindings colliding on the same Env key", () => {
    expect(() =>
      assembleBindings({
        dataDir: dataDir(),
        d1: ["DB"],
        secrets: { DB: "x" },
      }),
    ).toThrow(/duplicate binding/);
  });
});
