/**
 * Bridge a real client WebSocket (HTTP `Upgrade`) to a mount's Durable Object.
 *
 * Node has no built-in WebSocket *server*, and the workerd model is inverted
 * from `ws`: a DO answers an upgrade by returning `Response(101, { webSocket })`
 * and pushes events with `server.send()`. This wires the two together. On an
 * `upgrade` event the host:
 *
 *   1. builds a `fetch` `Request` from the raw upgrade and routes it to the
 *      mount whose reserved paths match (same precedence as normal dispatch);
 *   2. if the handler returns a `101` carrying a {@link EmulatedWebSocket},
 *      completes the real handshake with `ws` and bridges the two ends — frames
 *      the DO sends flow out to the network, and frames from the network are
 *      delivered to the DO (its `webSocketMessage` override, via
 *      {@link DurableObjectState.acceptWebSocket});
 *   3. otherwise destroys the socket (no upgrade).
 *
 * @see spec/self-hosting.md §7.4 (WebSocket hibernation)
 */

import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import type { Logger } from "@dwk/log";
import { HostExecutionContext, type WaitUntilTracker } from "./context";
import { isReservedPath, type Mount } from "./config";
import { responseWebSocket, type EmulatedWebSocket } from "./web-socket";

/** Wiring the upgrade handler needs — a subset of the server's own state. */
export interface UpgradeContext {
  readonly mounts: readonly Mount[];
  readonly env: Readonly<Record<string, unknown>>;
  readonly origin: string;
  readonly tracker: WaitUntilTracker;
  readonly logger: Logger;
}

/** A web `Request` reconstructed from a raw HTTP upgrade (always a bodyless GET). */
function upgradeRequest(req: IncomingMessage, origin: string): Request {
  const url = new URL(req.url ?? "/", origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return new Request(url, { method: "GET", headers });
}

/** Convert a `ws` binary frame to the `ArrayBuffer` the DO expects. */
function toArrayBuffer(data: Buffer): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

/** Splice a network socket onto the DO's in-process end. */
function bridge(real: WsWebSocket, pod: EmulatedWebSocket): void {
  // DO → network: a frame the DO `send`s surfaces as a `message` on this end.
  pod.addEventListener("message", (event) => {
    const data = (
      event as unknown as {
        data: string | ArrayBufferLike | ArrayBufferView;
      }
    ).data;
    real.send(data);
  });
  pod.addEventListener("close", () => real.close());
  // network → DO: deliver to the DO's accepted (server) end → webSocketMessage.
  real.on("message", (data: Buffer, isBinary: boolean) => {
    pod.send(isBinary ? toArrayBuffer(data) : data.toString());
  });
  real.on("close", () => pod.close());
  real.on("error", () => pod.close());
}

/**
 * Attach an `upgrade` handler to `server` that routes WebSocket upgrades to the
 * matching mount and bridges the connection. A no-op for paths no mount claims.
 */
export function attachWebSocketUpgrade(
  server: Server,
  ctx: UpgradeContext,
): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? "/", ctx.origin).pathname;
    const mount = ctx.mounts.find((m) =>
      isReservedPath(pathname, m.reservedPaths),
    );
    if (mount === undefined) {
      socket.destroy();
      return;
    }

    void (async () => {
      try {
        const request = upgradeRequest(req, ctx.origin);
        const exec = new HostExecutionContext(ctx.tracker);
        const response = await mount.handler(request, ctx.env as never, exec);
        const pod = responseWebSocket(response);
        if (response.status !== 101 || pod === null) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (real) => bridge(real, pod));
      } catch (err) {
        ctx.logger.error("server.upgrade_error", {
          mount: mount.name,
          error: err instanceof Error ? err.message : String(err),
        });
        socket.destroy();
      }
    })();
  });
}
