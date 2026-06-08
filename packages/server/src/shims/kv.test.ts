import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKVNamespace } from "./kv";
import type { KVNamespace } from "@cloudflare/workers-types";

describe("KV → SQLite/memory shim", () => {
  it("puts and gets text and JSON", async () => {
    const kv = createKVNamespace();
    await kv.put("a", "plain");
    expect(await kv.get("a")).toBe("plain");

    await kv.put("b", JSON.stringify({ x: 1 }));
    expect(await kv.get("b", "json")).toEqual({ x: 1 });
    expect(await kv.get("missing")).toBeNull();
  });

  it("expires entries past their TTL", async () => {
    let clock = 1_000_000;
    const kv = createKVNamespace({ now: () => clock });
    await kv.put("temp", "v", { expirationTtl: 60 });
    expect(await kv.get("temp")).toBe("v");
    clock += 61_000;
    expect(await kv.get("temp")).toBeNull();
  });

  it("returns metadata via getWithMetadata", async () => {
    const kv = createKVNamespace();
    await kv.put("k", "v", { metadata: { tag: "t" } });
    const out = (await kv.getWithMetadata("k")) as {
      value: string;
      metadata: unknown;
    };
    expect(out.value).toBe("v");
    expect(out.metadata).toEqual({ tag: "t" });
  });

  it("lists by prefix", async () => {
    const kv = createKVNamespace();
    await kv.put("user:1", "a");
    await kv.put("user:2", "b");
    await kv.put("other", "c");
    const out = (await kv.list({ prefix: "user:" })) as {
      keys: { name: string }[];
    };
    expect(out.keys.map((k) => k.name).sort()).toEqual(["user:1", "user:2"]);
  });

  it("persists to SQLite across reopen", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "dwk-kv-")), "kv.sqlite");
    const first: KVNamespace = createKVNamespace({ location: path });
    await first.put("k", "persisted");
    const reopened = createKVNamespace({ location: path });
    expect(await reopened.get("k")).toBe("persisted");
  });

  it("deletes keys", async () => {
    const kv = createKVNamespace();
    await kv.put("k", "v");
    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
  });
});
