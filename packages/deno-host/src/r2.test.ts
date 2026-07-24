import { describe, expect, it } from "vitest";
import { createS3Bucket } from "./r2.js";
import { FakeS3Client } from "./test-harness.js";

const ENDPOINT = "https://s3.example.com/my-bucket";

function setup() {
  const client = new FakeS3Client();
  return { client, bucket: createS3Bucket({ client, endpoint: ENDPOINT }) };
}

describe("createS3Bucket", () => {
  it("round-trips a put through get: body, size, content type", async () => {
    const { bucket } = setup();
    const put = await bucket.put("hello.txt", "hello world", {
      httpMetadata: { contentType: "text/plain" },
    });
    expect(put.size).toBe(11);
    expect(put.httpMetadata?.contentType).toBe("text/plain");

    const got = await bucket.get("hello.txt");
    expect(got).not.toBeNull();
    expect(await got?.text()).toBe("hello world");
    expect(got?.size).toBe(11);
    expect(got?.httpMetadata?.contentType).toBe("text/plain");
    expect(got?.httpEtag).toBe(`"${got?.etag}"`);
  });

  it("round-trips customMetadata (lowercased, per S3 header case-folding)", async () => {
    const { bucket } = setup();
    await bucket.put("k", "v", {
      customMetadata: { traceId: "abc123", Source: "webmention" },
    });
    const got = await bucket.get("k");
    expect(got?.customMetadata).toEqual({
      traceid: "abc123",
      source: "webmention",
    });
  });

  it("get of an absent key returns null", async () => {
    const { bucket } = setup();
    expect(await bucket.get("missing")).toBeNull();
  });

  it("head of an absent key returns null; head of a present key omits the body", async () => {
    const { bucket } = setup();
    await bucket.put("k", "body-bytes");
    expect(await bucket.head("missing")).toBeNull();

    const head = await bucket.head("k");
    expect(head).not.toBeNull();
    expect(head?.size).toBe(10);
    expect((head as unknown as { body?: unknown }).body).toBeUndefined();
  });

  it("delete removes the key; deleting an absent key is not an error", async () => {
    const { bucket } = setup();
    await bucket.put("k", "v");
    await bucket.delete("k");
    expect(await bucket.get("k")).toBeNull();

    await expect(bucket.delete("never-existed")).resolves.toBeUndefined();
  });

  it("delete accepts a batch of keys", async () => {
    const { bucket } = setup();
    await bucket.put("a", "1");
    await bucket.put("b", "2");
    await bucket.delete(["a", "b"]);
    expect(await bucket.get("a")).toBeNull();
    expect(await bucket.get("b")).toBeNull();
  });

  it("streams a ReadableStream body without pre-buffering, reporting the correct size", async () => {
    const { bucket } = setup();
    const chunks = [
      new TextEncoder().encode("abc"),
      new TextEncoder().encode("defgh"),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    // An explicit (even empty) options object steers TypeScript to the
    // `R2Bucket.put` overload without `onlyIf`, which returns a non-null
    // `R2Object` — omitting the argument entirely resolves to the other
    // overload's `Promise<R2Object | null>` return type instead.
    const put = await bucket.put("stream.bin", stream, {});
    expect(put.size).toBe(8);

    const got = await bucket.get("stream.bin");
    expect(await got?.text()).toBe("abcdefgh");
  });

  it("accepts ArrayBuffer and Uint8Array bodies", async () => {
    const { bucket } = setup();
    const buf = new TextEncoder().encode("array-buffer").buffer;
    await bucket.put("ab", buf as ArrayBuffer);
    expect(await (await bucket.get("ab"))?.text()).toBe("array-buffer");

    const view = new TextEncoder().encode("uint8-view");
    await bucket.put("u8", view);
    expect(await (await bucket.get("u8"))?.text()).toBe("uint8-view");
  });

  it("percent-encodes key segments while preserving '/' as a separator", async () => {
    const { bucket } = setup();
    const key = "a dir/key with spaces & stuff.txt";
    await bucket.put(key, "content");
    expect(await (await bucket.get(key))?.text()).toBe("content");
  });

  it("writeHttpMetadata writes the stored content type into a Headers", async () => {
    const { bucket } = setup();
    await bucket.put("k", "v", { httpMetadata: { contentType: "text/csv" } });
    const got = await bucket.get("k");
    const headers = new Headers();
    got?.writeHttpMetadata(headers);
    expect(headers.get("content-type")).toBe("text/csv");
  });

  it("checksums.toJSON() is present and callable, per R2Object's shape", async () => {
    const { bucket } = setup();
    const put = await bucket.put("k", "v", {});
    expect(put.checksums.toJSON()).toEqual({});
  });

  it("put accepts a null body", async () => {
    const { bucket } = setup();
    const put = await bucket.put("empty", null, {});
    expect(put.size).toBe(0);
    expect(await (await bucket.get("empty"))?.text()).toBe("");
  });

  it("put accepts a Blob body", async () => {
    const { bucket } = setup();
    const blob = new Blob(["blob content"], { type: "text/plain" });
    const put = await bucket.put("blob-key", blob, {});
    expect(put.size).toBe(blob.size);
    expect(await (await bucket.get("blob-key"))?.text()).toBe("blob content");
  });

  it("R2ObjectBody exposes arrayBuffer/json/blob/bytes alongside text", async () => {
    const { bucket } = setup();
    await bucket.put("obj", JSON.stringify({ a: 1 }), {
      httpMetadata: { contentType: "application/json" },
    });
    const got = await bucket.get("obj");
    expect(await got?.json()).toEqual({ a: 1 });

    const asArrayBuffer = await (await bucket.get("obj"))?.arrayBuffer();
    expect(new TextDecoder().decode(asArrayBuffer)).toBe('{"a":1}');

    const asBytes = await (await bucket.get("obj"))?.bytes();
    expect(new TextDecoder().decode(asBytes)).toBe('{"a":1}');

    const asBlob = await (await bucket.get("obj"))?.blob();
    expect(await asBlob?.text()).toBe('{"a":1}');
  });

  it("swallows a response body that fails to drain rather than throwing", async () => {
    // A client whose response body is backed by an already-errored stream —
    // simulating a body that's unusable by the time this shim tries to
    // drain it (e.g. an already-consumed or disconnected response).
    const brokenBody = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller) {
          controller.error(new Error("simulated stream failure"));
        },
      });
    const client = {
      async fetch(): Promise<Response> {
        return new Response(brokenBody(), { status: 200 });
      },
    };
    const bucket = createS3Bucket({ client, endpoint: ENDPOINT });

    await expect(bucket.put("k", "v", {})).resolves.toBeDefined();
    await expect(bucket.head("k")).resolves.toBeDefined();
    await expect(bucket.delete("k")).resolves.toBeUndefined();
  });
});
