import { describe, it, expect } from "vitest";
import { readBodyCapped } from "./fetch.js";

describe("readBodyCapped", () => {
  it("reads a small body", async () => {
    const text = await readBodyCapped(new Response("hello"), 1024);
    expect(text).toBe("hello");
  });

  it("rejects a body whose Content-Length exceeds the cap", async () => {
    const response = new Response("x".repeat(100), {
      headers: { "content-length": "100" },
    });
    expect(await readBodyCapped(response, 10)).toBeNull();
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
    expect(await readBodyCapped(response, 10)).toBeNull();
  });

  it("reads a streamed body within the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ab"));
        controller.enqueue(new TextEncoder().encode("cd"));
        controller.close();
      },
    });
    expect(await readBodyCapped(new Response(stream), 10)).toBe("abcd");
  });

  it("ignores a non-numeric Content-Length and reads the body", async () => {
    const response = new Response("abc", {
      headers: { "content-length": "not-a-number" },
    });
    expect(await readBodyCapped(response, 1024)).toBe("abc");
  });

  it("returns null when the stream errors mid-read", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ab"));
        controller.error(new Error("boom"));
      },
    });
    expect(await readBodyCapped(new Response(stream), 1024)).toBeNull();
  });

  it("reads a null-body response via text()", async () => {
    // A 204 has no body stream; the null-body branch falls back to text().
    expect(await readBodyCapped(new Response(null, { status: 204 }), 10)).toBe(
      "",
    );
  });

  it("returns null when a null-body text() exceeds the cap", async () => {
    const fake = {
      headers: new Headers(),
      body: null,
      text: async () => "x".repeat(100),
    } as unknown as Response;
    expect(await readBodyCapped(fake, 10)).toBeNull();
  });

  it("returns null when a null-body text() throws", async () => {
    const fake = {
      headers: new Headers(),
      body: null,
      text: async () => {
        throw new Error("disturbed");
      },
    } as unknown as Response;
    expect(await readBodyCapped(fake, 10)).toBeNull();
  });
});
