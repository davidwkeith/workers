import { describe, expect, it, vi } from "vitest";
import { JsonRpcErrorCode } from "./jsonrpc.js";
import { LATEST_PROTOCOL_VERSION } from "./lifecycle.js";
import { createMcpServer } from "./server.js";
import type {
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  ToolDefinition,
} from "./types.js";

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echoes back its input.",
  inputSchema: { type: "object" },
  requiredScope: "",
  handler: (args) => ({
    content: [{ type: "text", text: String(args.text ?? "") }],
  }),
};

const publishTool: ToolDefinition = {
  name: "publish",
  description: "Publishes a post.",
  inputSchema: { type: "object" },
  requiredScope: "create",
  handler: () => ({ content: [{ type: "text", text: "published" }] }),
};

function server() {
  return createMcpServer({
    serverInfo: { name: "test-server", version: "1.0.0" },
    tools: [echoTool, publishTool],
  });
}

describe("createMcpServer#handleMessage", () => {
  it("responds to initialize with the negotiated protocol version and capabilities", async () => {
    const response = (await server().handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "c", version: "1" },
        },
      },
      { scopes: [] },
    )) as JsonRpcSuccessResponse;
    expect(response.result).toMatchObject({
      protocolVersion: LATEST_PROTOCOL_VERSION,
      serverInfo: { name: "test-server", version: "1.0.0" },
      capabilities: { tools: { listChanged: false } },
    });
  });

  it("does not respond to notifications/initialized even though it has no id", async () => {
    const response = await server().handleMessage(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { scopes: [] },
    );
    expect(response).toBeNull();
  });

  it("responds to ping with an empty result", async () => {
    const response = (await server().handleMessage(
      { jsonrpc: "2.0", id: "p", method: "ping" },
      { scopes: [] },
    )) as JsonRpcSuccessResponse;
    expect(response.result).toEqual({});
  });

  it("responds to tools/list with the registry listing", async () => {
    const response = (await server().handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { scopes: [] },
    )) as JsonRpcSuccessResponse;
    expect((response.result as { tools: unknown[] }).tools).toHaveLength(2);
  });

  it("responds to tools/call, threading the caller's scopes through the registry", async () => {
    const response = (await server().handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "publish", arguments: {} },
      },
      { scopes: ["create"] },
    )) as JsonRpcSuccessResponse;
    expect(response.result).toEqual({
      content: [{ type: "text", text: "published" }],
    });
  });

  it("maps insufficient scope to a JSON-RPC error response, not a thrown exception", async () => {
    const response = (await server().handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "publish", arguments: {} },
      },
      { scopes: [] },
    )) as JsonRpcErrorResponse;
    expect(response.error.code).toBe(JsonRpcErrorCode.InsufficientScope);
  });

  it("returns Method not found for an unknown method", async () => {
    const response = (await server().handleMessage(
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
      { scopes: [] },
    )) as JsonRpcErrorResponse;
    expect(response.error.code).toBe(JsonRpcErrorCode.MethodNotFound);
  });

  it("suppresses any response to a notification, even an unknown method", async () => {
    const response = await server().handleMessage(
      { jsonrpc: "2.0", method: "resources/list" },
      { scopes: [] },
    );
    expect(response).toBeNull();
  });

  it("maps an unexpected tool-handler exception to a generic Internal error, logging it", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const boomTool: ToolDefinition = {
      name: "boom",
      description: "Always throws.",
      inputSchema: { type: "object" },
      requiredScope: "",
      handler: () => {
        throw new Error("boom");
      },
    };
    const boomServer = createMcpServer({
      serverInfo: { name: "test-server", version: "1.0.0" },
      tools: [boomTool],
    });
    const response = (await boomServer.handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "boom", arguments: {} },
      },
      { scopes: [] },
    )) as JsonRpcErrorResponse;
    expect(response.error).toEqual({
      code: JsonRpcErrorCode.InternalError,
      message: "Internal error",
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("createMcpServer#handleBody", () => {
  it("dispatches a single request object", async () => {
    const response = (await server().handleBody({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    })) as JsonRpcSuccessResponse;
    expect(response.result).toEqual({});
  });

  it("rejects a malformed single request", async () => {
    const response = (await server().handleBody({
      method: "ping",
    })) as JsonRpcErrorResponse;
    expect(response.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  it("dispatches a batch, preserving per-item responses and skipping notifications", async () => {
    const responses = (await server().handleBody([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ])) as JsonRpcResponse[];
    expect(responses).toHaveLength(2);
    expect(responses.map((r) => r.id)).toEqual([1, 2]);
  });

  it("returns null when a batch is entirely notifications", async () => {
    const response = await server().handleBody([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled" },
    ]);
    expect(response).toBeNull();
  });

  it("rejects an empty batch with a single Invalid Request error, per JSON-RPC 2.0", async () => {
    const response = (await server().handleBody([])) as JsonRpcErrorResponse;
    expect(Array.isArray(response)).toBe(false);
    expect(response.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  it("reports a malformed item within a batch as its own error response", async () => {
    const responses = (await server().handleBody([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "1.0", id: 2, method: "ping" },
    ])) as JsonRpcResponse[];
    expect(responses).toHaveLength(2);
    expect((responses[1] as JsonRpcErrorResponse).error.code).toBe(
      JsonRpcErrorCode.InvalidRequest,
    );
  });

  it("defaults to no granted scopes when the caller omits an auth context", async () => {
    const response = (await server().handleBody({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "publish", arguments: {} },
    })) as JsonRpcErrorResponse;
    expect(response.error.code).toBe(JsonRpcErrorCode.InsufficientScope);
  });
});
