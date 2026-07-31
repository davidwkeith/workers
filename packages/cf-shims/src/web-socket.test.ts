import { describe, it, expect } from "vitest";
import {
  installWebSocketGlobals,
  WebSocketPair,
  responseWebSocket,
} from "./web-socket.js";

function dataOf(event: Event): unknown {
  return (event as unknown as { data: unknown }).data;
}

describe("WebSocket hibernation primitives", () => {
  it("links the two ends: a send on one is a message on the other", () => {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const got: unknown[] = [];
    server.addEventListener("message", (e) => got.push(dataOf(e)));
    client.send("hi");
    expect(got).toEqual(["hi"]);
  });

  it("close propagates to the peer and silences later sends", () => {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    let serverClosed = false;
    const got: unknown[] = [];
    server.addEventListener("close", () => (serverClosed = true));
    server.addEventListener("message", (e) => got.push(dataOf(e)));

    client.close(1000, "bye");
    expect(serverClosed).toBe(true);
    client.close(); // second close is a no-op
    client.send("after-close"); // dropped: not OPEN
    expect(got).toEqual([]);
  });

  it("accept() is a no-op", () => {
    expect(() => new WebSocketPair()[0].accept()).not.toThrow();
  });

  it("deserializeAttachment() returns null before anything was ever attached", () => {
    const server = new WebSocketPair()[1];
    expect(server.deserializeAttachment()).toBeNull();
  });

  it("serializeAttachment()/deserializeAttachment() round-trip a value", () => {
    const server = new WebSocketPair()[1];
    server.serializeAttachment({ agent: "https://example.com/actor" });
    expect(server.deserializeAttachment()).toEqual({
      agent: "https://example.com/actor",
    });

    // A later call overwrites, matching workerd's "last write wins" semantics.
    server.serializeAttachment({ agent: "https://example.com/other" });
    expect(server.deserializeAttachment()).toEqual({
      agent: "https://example.com/other",
    });
  });

  it("installs globals (idempotent) and a 101 Response carries the socket", () => {
    installWebSocketGlobals();
    installWebSocketGlobals(); // idempotent: second call returns early
    expect(
      typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair,
    ).toBe("function");

    const socket = new WebSocketPair()[0];
    const upgrade = new Response(null, {
      status: 101,
      webSocket: socket as unknown as WebSocket,
    } as ResponseInit);
    expect(upgrade.status).toBe(101);
    expect(responseWebSocket(upgrade)).toBe(socket);

    // A normal response is untouched.
    const plain = new Response("ok", { status: 201 });
    expect(plain.status).toBe(201);
    expect(responseWebSocket(plain)).toBeNull();
  });
});
