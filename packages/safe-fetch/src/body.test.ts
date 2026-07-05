import { describe, it, expect } from "vitest";
import { readBodyCapped, readBytesCapped, MAX_BODY_BYTES } from "./body.js";

describe("readBodyCapped", () => {
  it("returns the body text when under the cap", async () => {
    const response = new Response("hello world");
    expect(await readBodyCapped(response, 1024)).toBe("hello world");
  });

  it("rejects up front on a lying Content-Length over the cap", async () => {
    const response = new Response("small body", {
      headers: { "content-length": "999999999" },
    });
    expect(await readBodyCapped(response, 1024)).toBeNull();
  });

  it("aborts a streamed body once it exceeds the cap, ignoring a missing Content-Length", async () => {
    const chunk = new Uint8Array(600).fill(65);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = new Response(stream);
    expect(await readBodyCapped(response, 1000)).toBeNull();
  });

  it("defaults to MAX_BODY_BYTES (2 MB) when no cap is given", async () => {
    expect(MAX_BODY_BYTES).toBe(2 * 1024 * 1024);
    const response = new Response("ok");
    expect(await readBodyCapped(response)).toBe("ok");
  });
});

describe("readBytesCapped", () => {
  it("returns the raw bytes when under the cap", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    const bytes = await readBytesCapped(response, 1024);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns null when the body exceeds the cap", async () => {
    const response = new Response(new Uint8Array(2000));
    expect(await readBytesCapped(response, 1024)).toBeNull();
  });
});
