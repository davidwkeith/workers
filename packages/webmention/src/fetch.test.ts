import { describe, it, expect } from "vitest";
import { readBodyCapped } from "./fetch";

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
});
