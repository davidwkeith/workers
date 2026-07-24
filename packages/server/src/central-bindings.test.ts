import { describe, it, expect } from "vitest";
import type {
  D1Database,
  R2Bucket,
  KVNamespace,
} from "@cloudflare/workers-types";
import { assembleCentralBindings } from "./central-bindings.js";
import {
  createFakeLibsqlClient,
  FakeS3Client,
} from "./central-test-harness.js";

describe("assembleCentralBindings", () => {
  it("creates a working D1 database over the injected libSQL client", async () => {
    const env = assembleCentralBindings({
      d1: { AUTH_DB: createFakeLibsqlClient() },
    });
    const db = env.AUTH_DB as D1Database;
    await db.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)");
    await db.prepare("INSERT INTO t VALUES (?, ?)").bind("a", "1").run();
    const row = await db
      .prepare("SELECT v FROM t WHERE k = ?")
      .bind("a")
      .first<{ v: string }>();
    expect(row?.v).toBe("1");
  });

  it("two D1 bindings sharing one client see each other's writes", async () => {
    const client = createFakeLibsqlClient();
    const env = assembleCentralBindings({
      d1: { AUTH_DB: client, MICROPUB_DB: client },
    });
    const authDb = env.AUTH_DB as D1Database;
    const micropubDb = env.MICROPUB_DB as D1Database;
    await authDb.exec("CREATE TABLE shared (k TEXT PRIMARY KEY)");
    await authDb.prepare("INSERT INTO shared VALUES (?)").bind("x").run();
    const row = await micropubDb
      .prepare("SELECT k FROM shared WHERE k = ?")
      .bind("x")
      .first<{ k: string }>();
    expect(row?.k).toBe("x");
  });

  it("creates a working R2 bucket over the injected S3-compatible client", async () => {
    const env = assembleCentralBindings({
      r2: {
        MEDIA: {
          client: new FakeS3Client(),
          endpoint: "https://s3.example.com/my-bucket",
        },
      },
    });
    const bucket = env.MEDIA as R2Bucket;
    await bucket.put("hello.txt", "hi");
    const got = await bucket.get("hello.txt");
    expect(await got?.text()).toBe("hi");
  });

  it("always backs a KV binding in-memory", async () => {
    const env = assembleCentralBindings({ kv: ["SESSION_CACHE"] });
    const kv = env.SESSION_CACHE as KVNamespace;
    await kv.put("k", "v");
    expect(await kv.get("k")).toBe("v");
  });

  it("merges secrets, skipping undefined values", () => {
    const env = assembleCentralBindings({
      secrets: { TOKEN_SIGNING_KEY: "abc", UNSET: undefined },
    });
    expect(env.TOKEN_SIGNING_KEY).toBe("abc");
    expect("UNSET" in env).toBe(false);
  });

  it("throws on a duplicate binding name across kinds", () => {
    expect(() =>
      assembleCentralBindings({
        d1: { SAME: createFakeLibsqlClient() },
        secrets: { SAME: "oops" },
      }),
    ).toThrow(/duplicate binding/);
  });
});
