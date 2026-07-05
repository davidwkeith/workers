import { describe, it, expect } from "vitest";
import { readRequestBodyCapped } from "./body.js";

function requestWith(body: BodyInit, contentLength?: string): Request {
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  return new Request("https://example.com/inbox", {
    method: "POST",
    headers,
    body,
  });
}

describe("readRequestBodyCapped", () => {
  it("rejects a body over the declared Content-Length cap without reading it", async () => {
    const request = requestWith("hello world", "1000");
    expect(await readRequestBodyCapped(request, 10)).toBeNull();
  });

  it("reads a body within the cap", async () => {
    const request = requestWith("hi");
    const bytes = await readRequestBodyCapped(request, 1024);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("hi");
  });

  it("aborts a streamed body that exceeds the cap despite a missing/lying header", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20));
        controller.close();
      },
    });
    const request = requestWith(stream);
    expect(await readRequestBodyCapped(request, 10)).toBeNull();
  });

  it("returns null for a lying Content-Length under the cap but an actually-larger stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(20));
        controller.close();
      },
    });
    const request = requestWith(stream, "5");
    expect(await readRequestBodyCapped(request, 10)).toBeNull();
  });
});
