import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toWebRequest, sendWebResponse } from "./adapter";

type WebHandler = (request: Request) => Promise<Response>;

let active: Server | null = null;

/** Stand up a bare node:http server driven by the adapter, return its base URL. */
async function serve(handler: WebHandler): Promise<string> {
  const server = createServer((req, res) => {
    void (async () => {
      const request = toWebRequest(req, "http://127.0.0.1");
      const response = await handler(request);
      await sendWebResponse(res, response);
    })();
  });
  active = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (active) {
    await new Promise<void>((resolve) => active!.close(() => resolve()));
    active = null;
  }
});

describe("Express⇄Fetch adapter", () => {
  it("reconstructs the URL from the configured origin, not the Host header", async () => {
    const base = await serve(async (req) => new Response(req.url));
    const res = await fetch(`${base}/path?q=1`, {
      headers: { host: "evil.example" },
    });
    expect(await res.text()).toBe("http://127.0.0.1/path?q=1");
  });

  it("passes method and headers through", async () => {
    const base = await serve(
      async (req) =>
        new Response(
          JSON.stringify({
            method: req.method,
            ct: req.headers.get("content-type"),
          }),
        ),
    );
    const res = await fetch(`${base}/`, {
      method: "DELETE",
      headers: { "content-type": "text/plain" },
    });
    expect(await res.json()).toEqual({ method: "DELETE", ct: "text/plain" });
  });

  it("streams a request body and echoes it back (round-trip streaming)", async () => {
    const base = await serve(
      async (req) =>
        new Response(req.body, {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const payload = "x".repeat(100_000);
    const res = await fetch(`${base}/upload`, {
      method: "POST",
      body: payload,
    });
    expect(await res.text()).toBe(payload);
  });

  it("copies status and emits multiple Set-Cookie headers separately", async () => {
    const base = await serve(async () => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response("teapot", { status: 418, headers });
    });
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(418);
    const cookies =
      (
        res.headers as Headers & { getSetCookie?: () => string[] }
      ).getSetCookie?.() ?? [];
    expect(cookies).toContain("a=1");
    expect(cookies).toContain("b=2");
  });

  it("handles a null body (204)", async () => {
    const base = await serve(async () => new Response(null, { status: 204 }));
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});
