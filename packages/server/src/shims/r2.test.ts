import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createR2Bucket } from "./r2";
import type { R2Bucket } from "@cloudflare/workers-types";

function bucket(): R2Bucket {
  return createR2Bucket(mkdtempSync(join(tmpdir(), "dwk-r2-")));
}

async function streamOf(text: string): Promise<ReadableStream> {
  return new Response(text).body as ReadableStream;
}

describe("R2 → filesystem shim", () => {
  let r2: R2Bucket;

  beforeEach(() => {
    r2 = bucket();
  });

  it("puts and gets a string body with a stable etag", async () => {
    const put = await r2.put("doc.txt", "hello world");
    expect(put).not.toBeNull();
    expect(put!.size).toBe(11);
    expect(put!.etag).toMatch(/^[0-9a-f]{32}$/);
    expect(put!.httpEtag).toBe(`"${put!.etag}"`);

    const got = await r2.get("doc.txt");
    expect(got).not.toBeNull();
    expect(await got!.text()).toBe("hello world");
    expect(got!.etag).toBe(put!.etag);
  });

  it("returns null for a missing key on get and head", async () => {
    expect(await r2.get("nope")).toBeNull();
    expect(await r2.head("nope")).toBeNull();
  });

  it("streams a ReadableStream body to and from disk", async () => {
    await r2.put("sha256-abc/blob", await streamOf("streamed payload"));
    const got = await r2.get("sha256-abc/blob");
    const body = got!.body;
    const text = await new Response(body).text();
    expect(text).toBe("streamed payload");
    expect(got!.size).toBe("streamed payload".length);
  });

  it("preserves httpMetadata content-type and custom metadata", async () => {
    await r2.put("a.json", "{}", {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { owner: "alice" },
    });
    const head = await r2.head("a.json");
    expect(head!.httpMetadata?.contentType).toBe("application/json");
    expect(head!.customMetadata).toEqual({ owner: "alice" });
    const headers = new Headers();
    head!.writeHttpMetadata(headers as never);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("deletes objects (and tolerates missing keys)", async () => {
    await r2.put("gone", "x");
    await r2.delete("gone");
    expect(await r2.head("gone")).toBeNull();
    await expect(r2.delete("never-existed")).resolves.toBeUndefined();
  });

  it("lists by prefix and applies a delimiter", async () => {
    await r2.put("blobs/a", "1");
    await r2.put("blobs/b", "2");
    await r2.put("other/c", "3");

    const blobs = await r2.list({ prefix: "blobs/" });
    expect(blobs.objects.map((o) => o.key).sort()).toEqual([
      "blobs/a",
      "blobs/b",
    ]);

    const top = await r2.list({ delimiter: "/" });
    expect(top.delimitedPrefixes.sort()).toEqual(["blobs/", "other/"]);
  });

  it("assigns a fresh version on each put", async () => {
    const first = await r2.put("v", "1");
    const second = await r2.put("v", "2");
    expect(second!.version).not.toBe(first!.version);
    expect(await (await r2.get("v"))!.text()).toBe("2");
  });

  it("rejects keys that escape the bucket root", async () => {
    await expect(r2.put("../escape", "x")).rejects.toThrow();
  });
});
