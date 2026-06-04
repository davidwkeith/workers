import { describe, it, expect } from "vitest";
import { readBytesCapped, MAX_BODY_BYTES } from "./fetch";

describe("readBytesCapped", () => {
  it("reads a small body", async () => {
    const bytes = await readBytesCapped(new Response("hello"), 1024);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("hello");
  });

  it("defaults to MAX_BODY_BYTES when no cap is given", async () => {
    const bytes = await readBytesCapped(new Response("hi"));
    expect(bytes).not.toBeNull();
    expect(bytes!.byteLength).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });

  it("rejects a body whose Content-Length exceeds the cap", async () => {
    const response = new Response("x".repeat(100), {
      headers: { "content-length": "100" },
    });
    expect(await readBytesCapped(response, 10)).toBeNull();
  });

  it("ignores a non-numeric Content-Length and reads the body", async () => {
    const response = new Response("abc", {
      headers: { "content-length": "not-a-number" },
    });
    const bytes = await readBytesCapped(response, 1024);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("abc");
  });

  it("rejects an oversized streamed body even without Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(50)));
        controller.enqueue(new TextEncoder().encode("y".repeat(50)));
        controller.close();
      },
    });
    const response = new Response(stream);
    expect(await readBytesCapped(response, 10)).toBeNull();
  });

  it("reads a streamed body within the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ab"));
        controller.enqueue(new TextEncoder().encode("cd"));
        controller.close();
      },
    });
    const bytes = await readBytesCapped(new Response(stream), 10);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe("abcd");
  });

  it("returns null when the stream errors mid-read", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ab"));
        controller.error(new Error("boom"));
      },
    });
    expect(await readBytesCapped(new Response(stream), 1024)).toBeNull();
  });

  it("reads a null-body response via arrayBuffer", async () => {
    // A 204 has no body; arrayBuffer() yields an empty buffer.
    const bytes = await readBytesCapped(new Response(null, { status: 204 }), 10);
    expect(bytes).not.toBeNull();
    expect(bytes!.byteLength).toBe(0);
  });

  it("returns null when a null-body arrayBuffer exceeds the cap", async () => {
    // Force the body===null branch with an arrayBuffer over the cap by faking
    // a Response-like object: body is null, arrayBuffer resolves oversized.
    const fake = {
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => new ArrayBuffer(100),
    } as unknown as Response;
    expect(await readBytesCapped(fake, 10)).toBeNull();
  });

  it("returns null when a null-body arrayBuffer throws", async () => {
    const fake = {
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => {
        throw new Error("disturbed");
      },
    } as unknown as Response;
    expect(await readBytesCapped(fake, 10)).toBeNull();
  });
});
