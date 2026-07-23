import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket as WsClient } from "ws";
import { noopLogger } from "@dwk/log";

import { installWebSocketGlobals } from "@dwk/cf-shims";
import { attachWebSocketUpgrade } from "./web-socket-upgrade.js";
import { WaitUntilTracker } from "./context.js";
import type { Mount } from "./config.js";

installWebSocketGlobals();

interface Harness {
  readonly origin: string;
  close(): Promise<void>;
}

const open: Server[] = [];

afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

function start(mounts: Mount[]): Promise<Harness> {
  const server = createServer((_req, res) => res.end());
  open.push(server);
  const detach = attachWebSocketUpgrade(server, {
    mounts,
    env: {},
    origin: "http://host",
    tracker: new WaitUntilTracker(),
    logger: noopLogger,
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        origin: `ws://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            detach();
            server.close(() => r());
          }),
      });
    });
  });
}

/** Resolve the HTTP status (+ optional header) a failed upgrade returned. */
function failedUpgrade(
  url: string,
): Promise<{ status: number; auth: string | undefined }> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url);
    ws.on("open", () =>
      reject(new Error("expected the upgrade to be rejected")),
    );
    ws.on("unexpected-response", (_req, res) => {
      resolve({
        status: res.statusCode ?? 0,
        auth: res.headers["www-authenticate"],
      });
      res.destroy();
    });
    ws.on("error", () => {
      /* a follow-up error after the rejection is expected; ignore */
    });
  });
}

describe("attachWebSocketUpgrade rejections", () => {
  it("relays a non-101 handler Response (status + headers) to the client", async () => {
    const mount: Mount = {
      name: "deny",
      reservedPaths: ["/sub"],
      handler: () =>
        Promise.resolve(
          new Response("denied", {
            status: 401,
            headers: { "www-authenticate": 'DPoP realm="solid"' },
          }),
        ),
    };
    const h = await start([mount]);
    try {
      const result = await failedUpgrade(`${h.origin}/sub`);
      expect(result.status).toBe(401);
      expect(result.auth).toContain("DPoP");
    } finally {
      await h.close();
    }
  });

  it("returns 404 for an upgrade to a path no mount claims", async () => {
    const h = await start([
      {
        name: "x",
        reservedPaths: ["/sub"],
        handler: () => Promise.resolve(new Response()),
      },
    ]);
    try {
      expect((await failedUpgrade(`${h.origin}/elsewhere`)).status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("returns 500 when the handler throws", async () => {
    const mount: Mount = {
      name: "boom",
      reservedPaths: ["/sub"],
      handler: () => Promise.reject(new Error("kaboom")),
    };
    const h = await start([mount]);
    try {
      expect((await failedUpgrade(`${h.origin}/sub`)).status).toBe(500);
    } finally {
      await h.close();
    }
  });
});
