import { describe, it, expect } from "vitest";
import { installRequestDuplex } from "./request-duplex";

/** A one-chunk stream body — invalid as a Request body without `duplex`. */
function streamBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hi"));
      controller.close();
    },
  });
}

describe("installRequestDuplex", () => {
  it("defaults duplex for a streaming body, and is idempotent", async () => {
    installRequestDuplex();
    installRequestDuplex(); // second call early-returns (already patched)

    // Without the patch this throws "duplex option is required".
    const req = new Request("http://x/", {
      method: "POST",
      body: streamBody(),
    });
    expect(await req.text()).toBe("hi");
  });

  it("leaves bodyless requests and explicit duplex untouched", async () => {
    installRequestDuplex();

    const bodyless = new Request("http://x/", { method: "GET" });
    expect(bodyless.method).toBe("GET");

    const explicit = new Request("http://x/", {
      method: "POST",
      body: streamBody(),
      duplex: "half",
    } as unknown as RequestInit);
    expect(await explicit.text()).toBe("hi");
  });
});
